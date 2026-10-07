import { useState, useMemo, type Key } from 'react';
import {
  Table,
  Card,
  Input,
  Button,
  Tag,
  Space,
  Typography,
  Modal,
  Empty,
  Grid,
  Divider,
  Tooltip,
  Checkbox,
  Alert,
  Select,
  App as AntdApp,
  type CheckboxProps,
} from 'antd';
import {
  SearchOutlined,
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  SyncOutlined,
  CloseCircleOutlined,
  TeamOutlined,
  SafetyOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import { TelegramGroupMapping } from '@mahalla-ovozi/api-contracts';
import { TelegramGroupDrawer } from './TelegramGroupDrawer.js';
import { useTelegramGroups } from '../district/useTelegramGroups.js';
import { useOptionalAuth } from '../auth/auth-context.js';
import { themeColors } from '../theme/antd-theme.js';

const { Text, Paragraph } = Typography;
const { useBreakpoint } = Grid;

interface TelegramGroupTableProps {
  districtId: string;
  isOffline?: boolean;
}

/** The paused-state filter over the group list (spec story 33). */
type PausedStateFilter = 'ALL' | 'PAUSED' | 'ACTIVE';

const PAUSED_FILTER_OPTIONS: Array<{ value: PausedStateFilter; label: string }> = [
  { value: 'ALL', label: 'Барча гуруҳлар' },
  { value: 'PAUSED', label: 'Фақат тўхтатилганлар' },
  { value: 'ACTIVE', label: 'Фақат фаоллар' },
];

/** Renders the paused badge text. A zero counter states the fact without manufacturing alarm. */
export function pausedBadgeLabel(skippedCount: number): string {
  return skippedCount > 0
    ? `Тўхтатилган — ${skippedCount} та хабар ўтказиб юборилди`
    : 'Тўхтатилган — ҳали хабар ўтказиб юборилмади';
}

/**
 * Renders the paused indicator for a group.
 *
 * The badge reports the skipped count that the Product Owner operates on, so it is gated to the
 * Product Owner alongside the pause/resume controls. Spec line 534 leaves the District Hokim's
 * visibility explicitly unsettled; until that is decided the safest default is to hide it, because
 * showing it would expose an operator decision as part of the reader's view.
 */
function renderPausedBadge(record: TelegramGroupMapping, canSeePausedState: boolean) {
  if (!record.isPaused || !canSeePausedState) return null;
  return (
    <Tag
      color="warning"
      icon={<PauseCircleOutlined aria-hidden="true" />}
      data-testid={`paused-badge-${record.id}`}
      style={{ whiteSpace: 'normal', margin: 0 }}
    >
      {pausedBadgeLabel(record.isPausedSkippedCount)}
    </Tag>
  );
}

export function TelegramGroupTable({ districtId, isOffline: isOfflineProp }: TelegramGroupTableProps) {
  const isOffline = isOfflineProp ?? false;
  const screens = useBreakpoint();
  const isDesktop = screens.md ?? true;

  const auth = useOptionalAuth();
  const actorRole = auth?.actor?.role;
  // Pause/resume is a Product Owner action. While the session is still resolving the role is
  // unknown, so the controls stay unavailable rather than flashing in and being denied. The
  // paused badge is gated the same way: the Hokim's visibility is an open product question
  // (spec line 534) and hiding it is the safe default until that is settled.
  const canPauseGroups = actorRole === 'PRODUCT_OWNER';
  const canSeePausedState = canPauseGroups;

  const { message } = AntdApp.useApp();

  const {
    groups,
    isLoading,
    error,
    deleteGroup,
    isDeleting,
    refetch,
    pauseGroups,
    isPausing,
    resumeGroups,
    isResuming,
  } = useTelegramGroups(districtId);

  const [searchText, setSearchText] = useState('');
  const [pausedFilter, setPausedFilter] = useState<PausedStateFilter>('ALL');
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<TelegramGroupMapping | null>(null);
  const [groupToDelete, setGroupToDelete] = useState<TelegramGroupMapping | null>(null);
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [pauseConfirmTargets, setPauseConfirmTargets] = useState<string[] | null>(null);

  const filteredGroups = useMemo(() => {
    const lower = searchText.toLowerCase();
    return groups.filter((g) => {
      if (pausedFilter === 'PAUSED' && !g.isPaused) return false;
      if (pausedFilter === 'ACTIVE' && g.isPaused) return false;
      if (!searchText.trim()) return true;
      return (
        g.mahallaName.toLowerCase().includes(lower) ||
        g.telegramChatTitle.toLowerCase().includes(lower) ||
        g.telegramChatId.includes(lower)
      );
    });
  }, [groups, searchText, pausedFilter]);

  const handleOpenAddDrawer = () => {
    setSelectedGroup(null);
    setIsDrawerOpen(true);
  };

  const handleOpenEditDrawer = (group: TelegramGroupMapping) => {
    setSelectedGroup(group);
    setIsDrawerOpen(true);
  };

  // The selection is an intersection with the visible rows, so a row hidden by the search
  // filter can never be carried into a bulk request the operator did not see.
  const selectedGroups = useMemo(
    () => filteredGroups.filter((group) => selectedRowKeys.includes(group.id)),
    [filteredGroups, selectedRowKeys],
  );
  const selectedVisibleIds = useMemo(
    () => selectedGroups.map((group) => group.id),
    [selectedGroups],
  );
  const pausableSelectedIds = useMemo(
    () => selectedGroups.filter((group) => !group.isPaused).map((group) => group.id),
    [selectedGroups],
  );
  const resumableSelectedIds = useMemo(
    () => selectedGroups.filter((group) => group.isPaused).map((group) => group.id),
    [selectedGroups],
  );

  const handlePauseRequest = () => {
    if (pausableSelectedIds.length === 0) return;
    setPauseConfirmTargets(pausableSelectedIds);
  };

  const handlePauseCancel = () => {
    setPauseConfirmTargets(null);
  };

  const handlePauseConfirm = async () => {
    if (!pauseConfirmTargets || pauseConfirmTargets.length === 0) return;
    try {
      await pauseGroups({ groupIds: pauseConfirmTargets });
      setPauseConfirmTargets(null);
      setSelectedRowKeys([]);
    } catch (err: unknown) {
      // The failure is surfaced to the operator rather than swallowed: a pause the operator
      // believes succeeded but did not is a hole in the record nobody knows about.
      message.error(
        err instanceof Error ? err.message : 'Гуруҳларни тўхтатишда хатолик юз берди.',
      );
    }
  };

  const handleResume = async () => {
    if (resumableSelectedIds.length === 0) return;
    try {
      await resumeGroups({ groupIds: resumableSelectedIds });
      setSelectedRowKeys([]);
    } catch (err: unknown) {
      message.error(
        err instanceof Error ? err.message : 'Гуруҳларни давом эттиришда хатолик юз берди.',
      );
    }
  };

  // Every row currently shown is selectable, and the only selection that can be acted on is the
  // intersection of the raw keys with the filtered rows, so a row hidden by the search box is
  // never carried into a request. The built-in header checkbox is retired because the explicit
  // control below states the filtered-view scope the operator is actually getting.
  const allVisibleSelected =
    filteredGroups.length > 0 && selectedVisibleIds.length === filteredGroups.length;

  const handleToggleSelectAllVisible = (checked: boolean) => {
    setSelectedRowKeys(checked ? filteredGroups.map((group) => group.id) : []);
  };

  const rowSelection = canPauseGroups
    ? {
        selectedRowKeys,
        hideSelectAll: true,
        onChange: (keys: Key[]) => {
          setSelectedRowKeys(keys.filter((key) => filteredGroups.some((g) => g.id === key)));
        },
        // Names each row checkbox after the Mahalla it selects, so the control is addressable
        // by the operator's vocabulary rather than by column position. antd's `CheckboxProps`
        // does not model ARIA attributes even though rc-checkbox forwards them to the real
        // input, so the assertion covers that library typing gap and nothing else.
        getCheckboxProps: (record: TelegramGroupMapping) =>
          ({ 'aria-label': `${record.mahallaName} гуруҳини танлаш` }) as unknown as Partial<CheckboxProps>,
      }
    : undefined;

  const handleDeleteConfirm = async () => {
    if (!groupToDelete) return;
    try {
      await deleteGroup({ groupId: groupToDelete.id });
      setGroupToDelete(null);
    } catch {
      // Error handled by mutation
    }
  };

  const renderStatusTag = (status: TelegramGroupMapping['status']) => {
    switch (status) {
      case 'VALID':
        return (
          <Tag color="success" icon={<CheckCircleOutlined aria-hidden="true" />}>
            ТАСДИҚЛАНГАН
          </Tag>
        );
      case 'TESTING':
        return (
          <Tag color="processing" icon={<SyncOutlined spin aria-hidden="true" />}>
            СИНОВДА
          </Tag>
        );
      case 'FAILED':
        return (
          <Tag color="error" icon={<CloseCircleOutlined aria-hidden="true" />}>
            ХАТОЛИК
          </Tag>
        );
      case 'PENDING':
      default:
        return (
          <Tag color="warning" icon={<ClockCircleOutlined aria-hidden="true" />}>
            КУТИЛМОҚДА
          </Tag>
        );
    }
  };

  const desktopColumns = [
    {
      title: 'Маҳалла номи',
      dataIndex: 'mahallaName',
      key: 'mahallaName',
      width: '20%',
      render: (name: string) => <Text strong>{name}</Text>,
    },
    {
      title: 'Telegram гуруҳ номи',
      dataIndex: 'telegramChatTitle',
      key: 'telegramChatTitle',
      width: '28%',
      render: (title: string, record: TelegramGroupMapping) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
          <Tooltip title={title} placement="topLeft">
            <Text
              style={{
                fontSize: '14px',
                fontWeight: 500,
                wordBreak: 'break-word',
                lineHeight: 1.4,
              }}
            >
              {title}
            </Text>
          </Tooltip>
          <div>
            <Text
              code
              copyable={{ text: record.telegramChatId, tooltips: ['Нусхалаш', 'Нусхаланди!'] }}
              type="secondary"
              style={{ fontSize: '12px' }}
            >
              ID: {record.telegramChatId}
            </Text>
          </div>
        </div>
      ),
    },
    {
      title: 'Транспорт',
      dataIndex: 'transport',
      key: 'transport',
      width: '12%',
      render: (transport: TelegramGroupMapping['transport']) =>
        transport === 'USERBOT' ? (
          <Tag color="purple">USERBOT</Tag>
        ) : (
          <Tag color="blue">BOT_API</Tag>
        ),
    },
    {
      title: 'Махфийлик режими',
      dataIndex: 'privacyModeDisabled',
      key: 'privacyModeDisabled',
      width: '20%',
      render: (disabled: boolean, record: TelegramGroupMapping) =>
        record.transport === 'USERBOT' ? (
          <Tag
            data-testid="privacy-mode-userbot"
            color="default"
            style={{ padding: '2px 8px', fontSize: '12px' }}
          >
            Талаб этилмайди (Тўлиқ қабул)
          </Tag>
        ) : disabled ? (
          <Tag
            data-testid="privacy-mode-disabled"
            color="success"
            icon={<SafetyOutlined />}
            style={{ padding: '2px 8px', fontSize: '12px' }}
          >
            Ўчирилган (Тўлиқ қабул)
          </Tag>
        ) : (
          <Tag
            data-testid="privacy-mode-restricted"
            color="volcano"
            icon={<SafetyOutlined />}
            style={{ padding: '2px 8px', fontSize: '12px' }}
          >
            Фаол (Чекланган)
          </Tag>
        ),
    },
    {
      title: 'Ҳолати',
      dataIndex: 'status',
      key: 'status',
      width: '20%',
      render: (status: TelegramGroupMapping['status'], record: TelegramGroupMapping) => (
        <Space direction="vertical" size={4} style={{ alignItems: 'flex-start' }}>
          {renderStatusTag(status)}
          {renderPausedBadge(record, canSeePausedState)}
        </Space>
      ),
    },
    {
      title: 'Амаллар',
      key: 'actions',
      width: '18%',
      align: 'right' as const,
      render: (_: unknown, record: TelegramGroupMapping) => (
        <Space size={4} wrap={false} style={{ justifyContent: 'flex-end' }}>
          <Button
            type="default"
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleOpenEditDrawer(record)}
            disabled={isOffline}
            style={{ display: 'inline-flex', alignItems: 'center' }}
          >
            Таҳрирлаш
          </Button>
          <Button
            danger
            type="text"
            size="small"
            icon={<DeleteOutlined />}
            onClick={() => setGroupToDelete(record)}
            disabled={isOffline}
            style={{ display: 'inline-flex', alignItems: 'center' }}
          >
            Ўчириш
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={
        <Space>
          <TeamOutlined style={{ fontSize: '20px', color: themeColors.colorPrimary }} />
          <span>Маҳаллалар ва Telegram гуруҳлари харитаси</span>
        </Space>
      }
      extra={
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={handleOpenAddDrawer}
          disabled={isOffline}
          size="middle"
          style={{ minHeight: '38px' }}
        >
          Янги гуруҳ қўшиш
        </Button>
      }
      style={{ marginTop: '24px' }}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {/* Search filter toolbar */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '12px',
          }}
        >
          <Input
            placeholder="Маҳалла номи ёки Chat ID бўйича қидириш..."
            prefix={<SearchOutlined style={{ color: themeColors.colorIconPlaceholder }} />}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            allowClear
            size="middle"
            style={{ maxWidth: '360px', width: '100%' }}
          />
          <Select<PausedStateFilter>
            value={pausedFilter}
            onChange={setPausedFilter}
            options={PAUSED_FILTER_OPTIONS}
            data-testid="paused-state-filter"
            size="middle"
            style={{ minWidth: '220px' }}
          />
          {filteredGroups.length > 0 && (
            <Text type="secondary" style={{ fontSize: '13px' }}>
              Жами: <Text strong>{filteredGroups.length}</Text> та гуруҳ
            </Text>
          )}
        </div>

        {canPauseGroups && filteredGroups.length > 0 && (
          <Alert
            type="info"
            showIcon
            data-testid="bulk-pause-toolbar"
            message={
              <Space wrap size="middle" align="center">
                <Checkbox
                  checked={allVisibleSelected}
                  onChange={(e) => handleToggleSelectAllVisible(e.target.checked)}
                  data-testid="select-all-visible"
                >
                  Кўринаётган барча гуруҳларни танлаш
                </Checkbox>
                {selectedVisibleIds.length > 0 && (
                  <Text strong>{`${selectedVisibleIds.length} та гуруҳ танланди`}</Text>
                )}
                <Button
                  type="primary"
                  icon={<PauseCircleOutlined />}
                  onClick={handlePauseRequest}
                  disabled={isOffline || isPausing || isResuming || pausableSelectedIds.length === 0}
                  style={{ minHeight: '44px' }}
                >
                  Танланганларни тўхтатиш
                </Button>
                <Button
                  type="default"
                  icon={<PlayCircleOutlined />}
                  onClick={handleResume}
                  disabled={isOffline || isPausing || isResuming || resumableSelectedIds.length === 0}
                  style={{ minHeight: '44px' }}
                >
                  Танланганларни давом эттириш
                </Button>
                <Button
                  type="link"
                  onClick={() => setSelectedRowKeys([])}
                  disabled={isPausing || isResuming}
                >
                  Танловни бекор қилиш
                </Button>
              </Space>
            }
          />
        )}

        {isLoading ? (
          <div style={{ textAlign: 'center', padding: '32px 0' }}>
            <SyncOutlined spin style={{ fontSize: '24px', color: themeColors.colorPrimary }} />
            <Paragraph style={{ marginTop: '8px' }}>Гуруҳлар рўйхати юкланмоқда...</Paragraph>
          </div>
        ) : error ? (
          <Empty description="Гуруҳларни юклашда хатолик юз берди." />
        ) : filteredGroups.length === 0 ? (
          <Empty
            description={
              searchText || pausedFilter !== 'ALL' ? (
                'Қидирув ёки филтр бўйича ҳеч қандай маҳалла топилмади.'
              ) : (
                <Space direction="vertical" align="center">
                  <Text strong>Ҳали биронта маҳалла гуруҳи бириктирилмаган</Text>
                  <Text type="secondary">
                    Туман маҳаллалари учун Telegram гуруҳларини қўшинг ва синовдан ўтказинг.
                  </Text>
                </Space>
              )
            }
          />
        ) : isDesktop ? (
          /* Desktop Table View */
          <Table
            dataSource={filteredGroups}
            columns={desktopColumns}
            rowKey="id"
            rowSelection={rowSelection}
            size="middle"
            pagination={{
              pageSize: 10,
              showSizeChanger: filteredGroups.length > 10,
              pageSizeOptions: ['10', '20', '50'],
              showTotal: (total, range) => `${total} та гуруҳдан ${range[0]}–${range[1]} кўрсатилмоқда`,
            }}
            scroll={{ x: 800 }}
          />
        ) : (
          /* Mobile Card List View (<768px) with WCAG >=44px touch targets */
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {filteredGroups.map((group) => (
              <Card key={group.id} size="small" style={{ borderRadius: '8px' }}>
                <Space direction="vertical" style={{ width: '100%' }} size="small">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Space align="center">
                      {canPauseGroups && (
                        <Checkbox
                          checked={selectedRowKeys.includes(group.id)}
                          onChange={(e) => {
                            setSelectedRowKeys((prev) =>
                              e.target.checked
                                ? [...prev, group.id]
                                : prev.filter((key) => key !== group.id),
                            );
                          }}
                          aria-label={`${group.mahallaName} гуруҳини танлаш`}
                        />
                      )}
                      <Text strong style={{ fontSize: '16px' }}>
                        {group.mahallaName}
                      </Text>
                    </Space>
                    <Space>
                      <Tag color={group.transport === 'USERBOT' ? 'purple' : 'blue'}>
                        {group.transport ?? 'BOT_API'}
                      </Tag>
                      {renderStatusTag(group.status)}
                    </Space>
                  </div>
                  {renderPausedBadge(group, canSeePausedState)}
                  <div>
                    <Text type="secondary">Гуруҳ: </Text>
                    <Text>{group.telegramChatTitle}</Text>
                  </div>
                  <div>
                    <Text type="secondary">Chat ID: </Text>
                    <Text code>{group.telegramChatId}</Text>
                  </div>
                  <Divider style={{ margin: '8px 0' }} />
                  <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '8px' }}>
                    <Button
                      type="default"
                      size="large"
                      icon={<EditOutlined />}
                      onClick={() => handleOpenEditDrawer(group)}
                      disabled={isOffline}
                      style={{ minHeight: '44px' }}
                    >
                      Таҳрирлаш
                    </Button>
                    <Button
                      danger
                      type="default"
                      size="large"
                      icon={<DeleteOutlined />}
                      onClick={() => setGroupToDelete(group)}
                      disabled={isOffline}
                      style={{ minHeight: '44px' }}
                    >
                      Ўчириш
                    </Button>
                  </div>
                </Space>
              </Card>
            ))}
          </Space>
        )}
      </Space>

      {/* Group Create/Edit Drawer */}
      <TelegramGroupDrawer
        open={isDrawerOpen}
        onClose={() => {
          setIsDrawerOpen(false);
          setSelectedGroup(null);
        }}
        districtId={districtId}
        onGroupSaved={() => {
          refetch();
        }}
        initialGroup={selectedGroup}
      />

      {/* Bulk Pause Confirmation Modal */}
      <Modal
        title="Гуруҳларни тўхтатишни тасдиқланг"
        open={pauseConfirmTargets !== null}
        onCancel={handlePauseCancel}
        footer={[
          <Button
            key="cancel"
            data-testid="pause-confirm-cancel"
            onClick={handlePauseCancel}
            size="large"
            style={{ minHeight: '44px' }}
          >
            Бекор қилиш
          </Button>,
          <Button
            key="pause"
            type="primary"
            data-testid="pause-confirm-submit"
            loading={isPausing}
            onClick={handlePauseConfirm}
            size="large"
            style={{ minHeight: '44px' }}
          >
            Тўхтатишни тасдиқлаш
          </Button>,
        ]}
      >
        <Space direction="vertical" style={{ width: '100%', marginTop: '12px' }}>
          <Paragraph strong data-testid="pause-confirm-count">
            {`${pauseConfirmTargets?.length ?? 0} та гуруҳ тўхтатилади.`}
          </Paragraph>
          <Alert
            type="warning"
            showIcon
            message="Тўхтатилган гуруҳлардан келадиган хабарлар йўқ қилинади"
            description="Гуруҳлар қайта давом эттирилмагунча улардан келган хабарлар тизимга сақланмайди ва қайта ишланмайди."
          />
          <Paragraph type="secondary">
            Бу амал гуруҳни ўчирмайди: Telegram билан алоқа ва маҳалла бириктирилиши сақланиб
            қолади. Қарор қайтариладиган — кейинроқ гуруҳни давом эттириш кифоя.
          </Paragraph>
        </Space>
      </Modal>

      {/* Delete Group Confirmation Modal */}
      <Modal
        title="Маҳалла гуруҳини ўчиришни тасдиқланг"
        open={!!groupToDelete}
        onCancel={() => setGroupToDelete(null)}
        footer={[
          <Button
            key="cancel"
            onClick={() => setGroupToDelete(null)}
            size="large"
            style={{ minHeight: '44px' }}
          >
            Бекор қилиш
          </Button>,
          <Button
            key="delete"
            danger
            type="primary"
            loading={isDeleting}
            onClick={handleDeleteConfirm}
            size="large"
            style={{ minHeight: '44px' }}
          >
            Ўчиришни тасдиқлаш
          </Button>,
        ]}
      >
        <Space direction="vertical" style={{ width: '100%', marginTop: '12px' }}>
          <Paragraph>
            Ҳақиқатан ҳам <Text strong>{groupToDelete?.mahallaName}</Text> маҳалласига бириктирилган
            Telegram гуруҳини ўчирмоқчимисиз?
          </Paragraph>
          <Paragraph type="secondary">
            Ўчирилгандан сўнг, ушбу гуруҳдан янги хабарлар қабул қилинмайди. Аввал қабул қилинган
            маълумотлар сақланиб қолади.
          </Paragraph>
        </Space>
      </Modal>
    </Card>
  );
}
