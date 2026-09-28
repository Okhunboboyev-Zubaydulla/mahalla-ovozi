import React, { useState, useEffect, useMemo } from 'react';
import {
  Table,
  Card,
  Space,
  Button,
  Tag,
  Input,
  Select,
  AutoComplete,
  DatePicker,
  Typography,
  theme,
  Alert,
  Modal,
  Form,
  message,
} from 'antd';
import {
  ReloadOutlined,
  PlusOutlined,
  EyeOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  SearchOutlined,
  SyncOutlined,
  DeleteOutlined,
  ClearOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import type {
  ListSignalsQuery,
  SignalMessageListItemDto,
  QualifyingLane,
} from '@mahalla-ovozi/api-contracts';
import { districtClient } from '../../district/district-client.js';
import { useDistrictMahallas } from '../../topics/district-topics-client.js';
import { useSignalMessages, useBatchDeleteSignals } from '../../hooks/useSignalMessages.js';
import { SignalInspectionDrawer } from './SignalInspectionDrawer.js';
import { CreateManualSignalModal } from './CreateManualSignalModal.js';

const { Text, Paragraph } = Typography;

const LANE_LABELS: Record<QualifyingLane, { label: string; color: string }> = {
  WATER: { label: 'Сув', color: 'blue' },
  ELECTRICITY: { label: 'Электр', color: 'gold' },
  GAS: { label: 'Газ', color: 'volcano' },
  WASTE: { label: 'Чиқинди', color: 'green' },
  HOKIM_RELATED: { label: 'Ҳокимлик', color: 'purple' },
};

const EXCLUSION_LABELS: Record<string, string> = {
  PLANNED_ANNOUNCEMENT: 'Режали эълон',
  ADVERTISEMENT_OR_SPAM: 'Реклама / Спам',
  SPECULATION_OR_RUMOR: 'Миш-миш / Тахмин',
  NEUTRAL_OR_PRAISE: 'Миннатдорчилик',
  GENERAL_CHATTER: 'Умумий суҳбат',
  UNRESOLVED_AMBIGUOUS_FRAGMENT: 'Ноаниқ қисқа матн',
  AI_PROCESSING_ERROR: 'АИ таҳлил хатолиги',
};

const SIGNAL_DATE_PRESETS: { label: string; value: () => [dayjs.Dayjs, dayjs.Dayjs] }[] = [
  { label: 'Бугун', value: () => [dayjs().startOf('day'), dayjs().endOf('day')] },
  {
    label: 'Сўнгги 7 кун',
    value: () => [dayjs().subtract(6, 'day').startOf('day'), dayjs().endOf('day')],
  },
  {
    label: 'Сўнгги 30 кун',
    value: () => [dayjs().subtract(29, 'day').startOf('day'), dayjs().endOf('day')],
  },
];

export interface SignalMonitoringTableProps {
  initialDistrictId?: string | null;
}

export const SignalMonitoringTable: React.FC<SignalMonitoringTableProps> = ({
  initialDistrictId,
}) => {
  const { token } = theme.useToken();

  // Filters State
  const [districtId, setDistrictId] = useState<string | undefined>(
    initialDistrictId || undefined,
  );
  const [mahallaName, setMahallaName] = useState<string>('');
  const [debouncedMahallaName, setDebouncedMahallaName] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'true' | 'false'>('all');
  const [laneFilter, setLaneFilter] = useState<QualifyingLane | undefined>(undefined);
  const [searchText, setSearchText] = useState<string>('');
  const [debouncedSearchText, setDebouncedSearchText] = useState<string>('');
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null);
  const [autoRefreshSec, setAutoRefreshSec] = useState<number | false>(
    process.env.NODE_ENV === 'test' ? false : 3_000,
  );
  const [pageSize, setPageSize] = useState<number>(20);

  // Pagination Cursor State & History Stack
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);

  // Sync with initialDistrictId changes from header
  useEffect(() => {
    setDistrictId(initialDistrictId || undefined);
    setMahallaName('');
    setDebouncedMahallaName('');
    setCursor(undefined);
    setCursorHistory([]);
  }, [initialDistrictId]);

  // Debounce search input by 300ms
  useEffect(() => {
    if (searchText === debouncedSearchText) return;
    const timer = setTimeout(() => {
      setDebouncedSearchText(searchText);
      setCursor(undefined);
      setCursorHistory([]);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchText, debouncedSearchText]);

  // Debounce mahalla input by 300ms
  useEffect(() => {
    if (mahallaName === debouncedMahallaName) return;
    const timer = setTimeout(() => {
      setDebouncedMahallaName(mahallaName);
      setCursor(undefined);
      setCursorHistory([]);
    }, 300);
    return () => clearTimeout(timer);
  }, [mahallaName, debouncedMahallaName]);

  // Modals / Drawer State
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null);
  const [inspectionDrawerOpen, setInspectionDrawerOpen] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [batchDeleteModalOpen, setBatchDeleteModalOpen] = useState<boolean>(false);
  const [batchDeleteForm] = Form.useForm();

  const batchDeleteMutation = useBatchDeleteSignals();

  const handleBatchDeleteSubmit = async (values: { changeReason: string }) => {
    if (selectedRowKeys.length === 0) return;
    try {
      const ids = selectedRowKeys.map(String);
      const result = await batchDeleteMutation.mutateAsync({
        ids,
        changeReason: values.changeReason,
      });
      message.success(`${result.deletedCount} та хабар муваффақиятли ўчирилди`);
      setSelectedRowKeys([]);
      setBatchDeleteModalOpen(false);
      batchDeleteForm.resetFields();
    } catch (err: any) {
      message.error(err.message || 'Хабарларни ўчиришда хатолик юз берди');
    }
  };

  // Query Districts
  const { data: districtsData } = useQuery({
    queryKey: ['districts', 'list'],
    queryFn: () => districtClient.listDistricts(),
    staleTime: 60_000,
  });

  // Query District Mahallas
  const { data: districtMahallasData } = useDistrictMahallas(districtId || null);

  const mahallaOptions = useMemo(() => {
    if (!districtMahallasData?.mahallas) return [];
    return districtMahallasData.mahallas.map((name) => ({
      value: name,
      label: name,
    }));
  }, [districtMahallasData]);

  const handleDistrictChange = (val?: string) => {
    setDistrictId(val);
    setMahallaName('');
    setDebouncedMahallaName('');
    setCursor(undefined);
    setCursorHistory([]);
  };

  const hasActiveFilters = Boolean(
    districtId !== (initialDistrictId || undefined) ||
      (mahallaName && mahallaName.trim().length > 0) ||
      statusFilter !== 'all' ||
      laneFilter ||
      (searchText && searchText.trim().length > 0) ||
      (dateRange && (dateRange[0] || dateRange[1])),
  );

  const handleResetFilters = () => {
    setDistrictId(initialDistrictId || undefined);
    setMahallaName('');
    setDebouncedMahallaName('');
    setStatusFilter('all');
    setLaneFilter(undefined);
    setSearchText('');
    setDebouncedSearchText('');
    setDateRange(null);
    setCursor(undefined);
    setCursorHistory([]);
  };

  // Query Signals
  const queryFilters: ListSignalsQuery = {
    districtId: districtId || undefined,
    mahallaName: (debouncedMahallaName || '').trim() || undefined,
    isRelevant: statusFilter === 'all' ? undefined : (statusFilter === 'true' ? true : false),
    lane: laneFilter,
    search: (debouncedSearchText || '').trim() || undefined,
    startDate: dateRange?.[0]?.isValid() ? dateRange[0].startOf('day').toISOString() : undefined,
    endDate: dateRange?.[1]?.isValid() ? dateRange[1].endOf('day').toISOString() : undefined,
    cursor,
    limit: pageSize,
    direction: 'forward',
  };

  const isModalOrDrawerOpen = inspectionDrawerOpen || createModalOpen || batchDeleteModalOpen;
  const isBrowsingHistory = Boolean(cursor);
  const shouldPauseRefresh = isModalOrDrawerOpen || isBrowsingHistory;

  const {
    data: signalsData,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useSignalMessages(queryFilters, {
    refetchInterval: shouldPauseRefresh ? false : autoRefreshSec,
  });

  const handleNextPage = () => {
    if (signalsData?.pagination?.nextCursor) {
      setCursorHistory((prev) => [...prev, cursor]);
      setCursor(signalsData.pagination.nextCursor);
    }
  };

  const handlePrevPage = () => {
    if (cursorHistory.length > 0) {
      const prev = [...cursorHistory];
      const targetCursor = prev.pop();
      setCursorHistory(prev);
      setCursor(targetCursor);
    }
  };

  const handleOpenDetail = (id: string) => {
    setSelectedSignalId(id);
    setInspectionDrawerOpen(true);
  };

  const columns = [
    {
      title: 'Вақти',
      dataIndex: 'originalTimestamp',
      key: 'originalTimestamp',
      width: 140,
      render: (ts: string) => (
        <Text style={{ fontSize: 13, color: token.colorTextSecondary }}>
          {new Date(ts).toLocaleString('uz-UZ', {
            timeZone: 'Asia/Tashkent',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </Text>
      ),
    },
    {
      title: 'Ҳудуд / Маҳалла',
      key: 'location',
      width: 170,
      render: (_: unknown, record: SignalMessageListItemDto) => (
        <div>
          <Text strong style={{ display: 'block', fontSize: 13 }}>
            {record.mahallaName}
          </Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {record.districtName || record.districtId}
          </Text>
        </div>
      ),
    },
    {
      title: 'Хабар матни (Message)',
      dataIndex: 'verbatimText',
      key: 'verbatimText',
      render: (text: string, record: SignalMessageListItemDto) => (
        <div style={{ maxWidth: 360 }}>
          <Paragraph
            ellipsis={{ rows: 2, expandable: false }}
            style={{
              margin: 0,
              fontSize: 13,
              lineHeight: 1.4,
              cursor: 'pointer',
            }}
            onClick={() => handleOpenDetail(record.id)}
          >
            {text}
          </Paragraph>
        </div>
      ),
    },
    {
      title: 'AI қарори',
      key: 'decision',
      width: 150,
      render: (_: unknown, record: SignalMessageListItemDto) => {
        if (record.status === 'PENDING') {
          return (
            <Tag color="processing" icon={<SyncOutlined spin />}>
              Жараёнда
            </Tag>
          );
        }
        if (record.status === 'ACCEPTED' || record.isRelevant) {
          return (
            <Tag color="success" icon={<CheckCircleOutlined />}>
              Қабул қилинди
            </Tag>
          );
        }
        return (
          <Tag color="default" icon={<CloseCircleOutlined />}>
            Рад этилди
          </Tag>
        );
      },
    },
    {
      title: 'Соҳа / Сабаб',
      key: 'lanesOrReason',
      width: 160,
      render: (_: unknown, record: SignalMessageListItemDto) => {
        if (record.isRelevant && record.relevantLanes.length > 0) {
          return (
            <Space wrap size={[0, 4]}>
              {record.relevantLanes.map((lane) => {
                const meta = LANE_LABELS[lane] || { label: lane, color: 'default' };
                return (
                  <Tag key={lane} color={meta.color} style={{ fontSize: 11 }}>
                    {meta.label}
                  </Tag>
                );
              })}
            </Space>
          );
        }
        if (record.exclusionReason) {
          return (
            <Tag color="warning" style={{ fontSize: 11 }}>
              {EXCLUSION_LABELS[record.exclusionReason] || record.exclusionReason}
            </Tag>
          );
        }
        return <Text type="secondary">—</Text>;
      },
    },
    {
      title: 'AI изоҳи / Асос (Reasoning)',
      dataIndex: 'reasoning',
      key: 'reasoning',
      width: 260,
      render: (reasoning: string | null, record: SignalMessageListItemDto) => {
        if (reasoning) {
          return (
            <div style={{ maxWidth: 300 }}>
              <Text
                style={{
                  fontSize: 12,
                  color: token.colorTextDescription,
                  fontStyle: 'italic',
                }}
              >
                {reasoning}
              </Text>
            </div>
          );
        }
        if (record.isRelevant || record.status === 'ACCEPTED') {
          return (
            <div style={{ maxWidth: 300 }}>
              <Text
                type="secondary"
                style={{
                  fontSize: 12,
                  fontStyle: 'italic',
                }}
              >
                Кетма-кет ёзилган хабар сифатида умумий баҳоланган
              </Text>
            </div>
          );
        }
        return <Text type="secondary">—</Text>;
      },
    },
    {
      title: 'Амаллар',
      key: 'actions',
      width: 100,
      fixed: 'right' as const,
      render: (_: unknown, record: SignalMessageListItemDto) => (
        <Button
          type="link"
          icon={<EyeOutlined />}
          size="small"
          onClick={() => handleOpenDetail(record.id)}
        >
          Кўриш
        </Button>
      ),
    },
  ];

  return (
    <div>
      {/* Top Filter Card */}
      <Card
        size="small"
        variant="borderless"
        style={{
          background: token.colorBgContainer,
          borderRadius: token.borderRadiusLG,
          marginBottom: 16,
        }}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 12,
            }}
          >
            <div>
              <Text strong style={{ fontSize: 16 }}>
                АИ хабар таснифи ва сигналлар мониторинги
              </Text>
              <Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
                Кирувчи Telegram хабарларининг қабул қилиниш/рад этилиш сабаблари ва тўлиқ AI асослари.
              </Paragraph>
            </div>

            <Space>
              <Select
                value={autoRefreshSec}
                onChange={(val) => setAutoRefreshSec(val)}
                style={{ width: 140 }}
                options={[
                  { label: 'Авто-янгилаш: 3с', value: 3_000 },
                  { label: 'Авто-янгилаш: 5с', value: 5_000 },
                  { label: 'Авто-янгилаш: 10с', value: 10_000 },
                  { label: 'Авто-янгилаш: 30с', value: 30_000 },
                  { label: 'Ўчирилган', value: false },
                ]}
              />

              <Button
                icon={<ReloadOutlined spin={isFetching} />}
                onClick={() => refetch()}
              >
                Янгилаш
              </Button>

              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => setCreateModalOpen(true)}
              >
                Янги сигнал қўшиш
              </Button>
            </Space>
          </div>

          {/* Filter Bar Controls */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 10,
              alignItems: 'center',
            }}
          >
            <Select
              allowClear
              placeholder="Барча туманлар"
              value={districtId}
              onChange={handleDistrictChange}
              style={{ width: 180 }}
              options={districtsData?.districts.map((d) => ({
                label: d.name,
                value: d.id,
              }))}
            />

            <AutoComplete
              allowClear
              placeholder="Маҳалла бўйича қидириш"
              value={mahallaName}
              onChange={(val) => setMahallaName(val || '')}
              onSelect={(val) => {
                setMahallaName(val);
                setDebouncedMahallaName(val);
                setCursor(undefined);
                setCursorHistory([]);
              }}
              options={mahallaOptions}
              filterOption={(inputValue, option) =>
                Boolean(
                  option?.value &&
                    String(option.value)
                      .toUpperCase()
                      .includes((inputValue || '').toUpperCase()),
                )
              }
              style={{ width: 210 }}
            />

            <Select
              value={statusFilter}
              onChange={(val) => {
                setStatusFilter(val);
                setCursor(undefined);
                setCursorHistory([]);
              }}
              style={{ width: 170 }}
              options={[
                { label: 'Барча қарорлар', value: 'all' },
                { label: 'Қабул қилинганлар', value: 'true' },
                { label: 'Рад этилганлар', value: 'false' },
              ]}
            />

            <Select
              allowClear
              placeholder="Барча соҳалар"
              value={laneFilter}
              onChange={(val) => {
                setLaneFilter(val);
                setCursor(undefined);
                setCursorHistory([]);
              }}
              style={{ width: 150 }}
              options={Object.entries(LANE_LABELS).map(([k, v]) => ({
                label: v.label,
                value: k,
              }))}
            />

            <DatePicker.RangePicker
              value={dateRange}
              onChange={(dates) => {
                setDateRange(dates as [dayjs.Dayjs | null, dayjs.Dayjs | null] | null);
                setCursor(undefined);
                setCursorHistory([]);
              }}
              presets={SIGNAL_DATE_PRESETS}
              placeholder={['Бошланғич сана', 'Якуний сана']}
              style={{ width: 260 }}
            />

            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="Матн бўйича қидириш..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              style={{ width: 200 }}
            />

            {hasActiveFilters && (
              <Button
                icon={<ClearOutlined />}
                onClick={handleResetFilters}
              >
                Филтрларни тозалаш
              </Button>
            )}
          </div>
        </Space>
      </Card>

      {/* Error Alert */}
      {isError && (
        <Alert
          type="error"
          message="Сигналларни юклашда хатолик"
          description={error instanceof Error ? error.message : 'Сервердан маълумот олишнинг имкони бўлмади.'}
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      {/* Batch Actions Bar */}
      {selectedRowKeys.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 20px',
            marginBottom: 16,
            background: token.colorFillAlter,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadiusLG,
          }}
        >
          <Space size="middle">
            <Text strong style={{ fontSize: 14 }}>
              Танланди: {selectedRowKeys.length} та хабар
            </Text>
            <Button
              type="link"
              size="small"
              onClick={() => setSelectedRowKeys([])}
            >
              Танловни бекор қилиш
            </Button>
          </Space>
          <Button
            danger
            type="primary"
            icon={<DeleteOutlined />}
            onClick={() => setBatchDeleteModalOpen(true)}
          >
            Танланганларни ўчириш ({selectedRowKeys.length})
          </Button>
        </div>
      )}

      {/* Data Table */}
      <Card
        variant="borderless"
        style={{
          borderRadius: token.borderRadiusLG,
          background: token.colorBgContainer,
        }}
        styles={{ body: { padding: 0 } }}
      >
        <Table
          rowKey="id"
          rowSelection={{
            selectedRowKeys,
            onChange: (newKeys) => setSelectedRowKeys(newKeys),
          }}
          columns={columns}
          dataSource={signalsData?.items || []}
          loading={isLoading}
          pagination={false}
          scroll={{ y: 560, x: 1100 }}
          size="middle"
          onRow={(record) => ({
            onClick: (e) => {
              const target = e.target as HTMLElement;
              if (
                target.closest('.ant-table-selection-column') ||
                target.closest('.ant-checkbox-wrapper') ||
                target.closest('button') ||
                target.closest('a') ||
                target.closest('.ant-dropdown-trigger') ||
                target.closest('input') ||
                target.closest('[role="button"]')
              ) {
                return;
              }
              handleOpenDetail(record.id);
            },
            style: { cursor: 'pointer' },
          })}
        />

        {/* Keyset Pagination Controls */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 24px',
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              Кўрсатилмоқда: {signalsData?.items?.length || 0} та сигнал
            </Text>
            <Tag color="default" style={{ margin: 0 }}>
              {cursorHistory.length + 1}-саҳифа
            </Tag>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Select
              value={pageSize}
              onChange={(val) => {
                setPageSize(val);
                setCursor(undefined);
                setCursorHistory([]);
              }}
              size="small"
              style={{ width: 120 }}
              options={[
                { label: '10 / саҳифа', value: 10 },
                { label: '20 / саҳифа', value: 20 },
                { label: '50 / саҳифа', value: 50 },
              ]}
            />
            <Button
              disabled={cursorHistory.length === 0}
              onClick={handlePrevPage}
            >
              Олдингиси
            </Button>
            <Button
              type="primary"
              disabled={!signalsData?.pagination?.hasNextPage}
              onClick={handleNextPage}
            >
              Кейингиси
            </Button>
          </div>
        </div>
      </Card>

      {/* Slide-out Drawer */}
      <SignalInspectionDrawer
        signalId={selectedSignalId}
        open={inspectionDrawerOpen}
        onClose={() => {
          setInspectionDrawerOpen(false);
          setSelectedSignalId(null);
        }}
      />

      {/* Create Manual Signal Modal */}
      <CreateManualSignalModal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        defaultDistrictId={districtId}
      />

      {/* Batch Delete Confirmation Modal */}
      <Modal
        title={
          <Space>
            <DeleteOutlined style={{ color: token.colorError }} />
            <span>Хабарларни гуруҳлаб ўчириш</span>
          </Space>
        }
        open={batchDeleteModalOpen}
        onCancel={() => {
          setBatchDeleteModalOpen(false);
          batchDeleteForm.resetFields();
        }}
        onOk={() => batchDeleteForm.submit()}
        okText="Ўчиришни тасдиқлаш"
        cancelText="Бекор қилиш"
        okButtonProps={{ danger: true, loading: batchDeleteMutation.isPending }}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`Жами ${selectedRowKeys.length} та танланган хабар ўчирилади.`}
          description="Агар танланган хабарлар орасида қабул қилинган далиллар бўлса, улар тегишли мавзулардан олиб ташланади ва мавзу хулосаси қайта ҳисобланади."
        />
        <Form form={batchDeleteForm} layout="vertical" onFinish={handleBatchDeleteSubmit}>
          <Form.Item
            name="changeReason"
            label="Ўчириш сабаби (аудит учун мажбурий)"
            rules={[
              { required: true, message: 'Ўчириш сабабини киритиш шарт' },
              { min: 3, message: 'Камида 3 та белги бўлиши керак' },
            ]}
          >
            <Input.TextArea
              rows={3}
              placeholder="Масалан: Такрорий ёки нотўғри хабарлар"
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
