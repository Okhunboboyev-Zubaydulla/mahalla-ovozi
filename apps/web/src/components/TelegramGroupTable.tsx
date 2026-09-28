import { useState, useMemo } from 'react';
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
} from '@ant-design/icons';
import { TelegramGroupMapping } from '@mahalla-ovozi/api-contracts';
import { TelegramGroupDrawer } from './TelegramGroupDrawer.js';
import { useTelegramGroups } from '../district/useTelegramGroups.js';
import { themeColors } from '../theme/antd-theme.js';

const { Text, Paragraph } = Typography;
const { useBreakpoint } = Grid;

interface TelegramGroupTableProps {
  districtId: string;
  isOffline?: boolean;
}

export function TelegramGroupTable({ districtId, isOffline: isOfflineProp }: TelegramGroupTableProps) {
  const isOffline = isOfflineProp ?? false;
  const screens = useBreakpoint();
  const isDesktop = screens.md ?? true;

  const { groups, isLoading, error, deleteGroup, isDeleting, refetch } = useTelegramGroups(districtId);

  const [searchText, setSearchText] = useState('');
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<TelegramGroupMapping | null>(null);
  const [groupToDelete, setGroupToDelete] = useState<TelegramGroupMapping | null>(null);

  const filteredGroups = useMemo(() => {
    if (!searchText.trim()) return groups;
    const lower = searchText.toLowerCase();
    return groups.filter(
      (g) =>
        g.mahallaName.toLowerCase().includes(lower) ||
        g.telegramChatTitle.toLowerCase().includes(lower) ||
        g.telegramChatId.includes(lower),
    );
  }, [groups, searchText]);

  const handleOpenAddDrawer = () => {
    setSelectedGroup(null);
    setIsDrawerOpen(true);
  };

  const handleOpenEditDrawer = (group: TelegramGroupMapping) => {
    setSelectedGroup(group);
    setIsDrawerOpen(true);
  };

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
      render: (disabled: boolean) =>
        disabled ? (
          <Tag color="success" icon={<SafetyOutlined />} style={{ padding: '2px 8px', fontSize: '12px' }}>
            Ўчирилган (Тўлиқ қабул)
          </Tag>
        ) : (
          <Tag color="volcano" icon={<SafetyOutlined />} style={{ padding: '2px 8px', fontSize: '12px' }}>
            Фаол (Чекланган)
          </Tag>
        ),
    },
    {
      title: 'Ҳолати',
      dataIndex: 'status',
      key: 'status',
      width: '14%',
      render: (status: TelegramGroupMapping['status']) => renderStatusTag(status),
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
          {filteredGroups.length > 0 && (
            <Text type="secondary" style={{ fontSize: '13px' }}>
              Жами: <Text strong>{filteredGroups.length}</Text> та гуруҳ
            </Text>
          )}
        </div>

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
              searchText ? (
                'Қидирув бўйича ҳеч қандай маҳалла топилмади.'
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
                    <Text strong style={{ fontSize: '16px' }}>
                      {group.mahallaName}
                    </Text>
                    <Space>
                      <Tag color={group.transport === 'USERBOT' ? 'purple' : 'blue'}>
                        {group.transport ?? 'BOT_API'}
                      </Tag>
                      {renderStatusTag(group.status)}
                    </Space>
                  </div>
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
