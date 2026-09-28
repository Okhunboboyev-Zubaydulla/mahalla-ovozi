import React, { useState, useMemo, useRef } from 'react';
import {
  Card,
  Typography,
  Tag,
  Button,
  Alert,
  Empty,
  Space,
  theme,
} from 'antd';
import {
  ReloadOutlined,
  CheckCircleOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import {
  DistrictTopicsSearchBody,
  TopicCardItem,
} from '@mahalla-ovozi/api-contracts';
import {
  useDistrictTopics,
  useDistrictTopicsMahallas,
} from '../../../topics/index.js';
import { formatTashkentDate } from '../../../lib/formatters.js';
import { DistrictTopicFilterBar } from './DistrictTopicFilterBar.js';
import { DistrictTopicsTable } from './DistrictTopicsTable.js';
import { DistrictTopicEvidenceDrawer } from './DistrictTopicEvidenceDrawer.js';

const { Title, Paragraph } = Typography;

export interface DistrictTopicsViewProps {
  activeDistrictId: string | null;
  activeDistrictName?: string | null;
}

export const DistrictTopicsView: React.FC<DistrictTopicsViewProps> = ({
  activeDistrictId,
  activeDistrictName,
}) => {
  const { token } = theme.useToken();

  const [filter, setFilter] = useState<DistrictTopicsSearchBody>({
    dateScope: 'today',
  });

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedTopic, setSelectedTopic] = useState<TopicCardItem | null>(null);
  const lastActiveElementRef = useRef<HTMLElement | null>(null);

  // Queries for topics and mahallas
  const {
    data,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useDistrictTopics(activeDistrictId, filter);

  const { data: mahallasData, isLoading: isLoadingMahallas } =
    useDistrictTopicsMahallas(activeDistrictId);

  // Flatten infinite query topic pages
  const topics = useMemo(() => {
    if (!data?.pages) return [];
    return data.pages.flatMap((page) => page.topics);
  }, [data]);

  const totalCount = data?.pages[0]?.totalCount ?? 0;
  const districtName =
    data?.pages[0]?.districtName || activeDistrictName || 'Танланган туман';
  const serverEvaluatedAt = data?.pages[0]?.serverEvaluatedAt;

  // Derive offline or stale status
  const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
  const isStale = (isOffline || isError) && topics.length > 0;

  const handleOpenEvidence = (
    topic: TopicCardItem,
    triggerElement: HTMLElement,
  ) => {
    lastActiveElementRef.current = triggerElement;
    setSelectedTopic(topic);
    setDrawerOpen(true);
  };

  const handleCloseEvidence = () => {
    setDrawerOpen(false);
  };

  const handleResetFilters = () => {
    setFilter({
      dateScope: 'today',
    });
  };

  // If no district is selected, render informative prompt
  if (!activeDistrictId) {
    return (
      <Card
        variant="borderless"
        style={{
          borderRadius: 12,
          backgroundColor: token.colorBgContainer,
          border: `1px solid ${token.colorBorderSecondary}`,
          padding: '40px 16px',
          textAlign: 'center',
        }}
      >
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <div style={{ maxWidth: 460, margin: '0 auto' }}>
              <Title level={4} style={{ marginBottom: 8, color: '#0F172A' }}>
                Туман танланмаган
              </Title>
              <Paragraph type="secondary" style={{ fontSize: 14 }}>
                Мавзулар ва далилларни кўриш учун юқоридаги рўйхатдан ёки танлагичдан туманни танланг.
              </Paragraph>
            </div>
          }
        />
      </Card>
    );
  }

  return (
    <div key={activeDistrictId} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header Card */}
      <Card
        variant="borderless"
        style={{
          borderRadius: 12,
          backgroundColor: token.colorBgContainer,
          border: `1px solid ${token.colorBorderSecondary}`,
        }}
        title={
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <div>
              <Space align="center" size={8}>
                <Title level={3} style={{ margin: 0 }}>
                  {districtName}
                </Title>
                <Tag color="success" icon={<CheckCircleOutlined />}>
                  Фаол
                </Tag>
              </Space>
              <Paragraph
                type="secondary"
                style={{ margin: '4px 0 0', fontSize: 13 }}
              >
                Туманда сақланган барча мавзулар ва далиллар (муаммоларни таҳлил қилиш учун)
              </Paragraph>
            </div>

            <Space size={8}>
              <Button
                icon={<ReloadOutlined spin={isFetching} />}
                onClick={() => void refetch()}
                disabled={isLoading}
                style={{ height: 36, borderRadius: 6 }}
                aria-label="Маълумотларни янгилаш"
              >
                Янгилаш
              </Button>
            </Space>
          </div>
        }
      >
        {/* Offline / Stale Cache Banner (AC 8) */}
        {isStale && (
          <Alert
            type="warning"
            showIcon
            icon={<InfoCircleOutlined />}
            message="Маълумотлар эскирган бўлиши мумкин"
            description={
              serverEvaluatedAt
                ? `Сервер билан боғланишда узилиш кузатилди. Сўнгги муваффақиятли янгиланиш вақти: ${formatTashkentDate(serverEvaluatedAt)}.`
                : 'Тармоқ билан алоқа мавжуд эмас. Кўрсатилаётган маълумотлар кэшдан олинган.'
            }
            style={{ marginBottom: 16, borderRadius: 6 }}
          />
        )}

        {/* Global Error Banner when no data available */}
        {isError && topics.length === 0 && (
          <div style={{ padding: '24px 0' }}>
            <Alert
              type="error"
              showIcon
              message="Мавзуларни юклаб бўлмади"
              description={
                error?.message || 'Сервер билан боғланишда хатолик юз берди.'
              }
              action={
                <Button type="primary" danger onClick={() => void refetch()}>
                  Қайта уриниш
                </Button>
              }
            />
          </div>
        )}

        {/* Multi-Parameter Filter Bar */}
        <DistrictTopicFilterBar
          filter={filter}
          mahallaOptions={mahallasData?.mahallas || []}
          isLoadingMahallas={isLoadingMahallas}
          onFilterChange={setFilter}
          onResetFilters={handleResetFilters}
          disabled={isLoading && topics.length === 0}
        />

        {/* Operational Topics Table */}
        <DistrictTopicsTable
          topics={topics}
          totalCount={totalCount}
          isLoading={isLoading}
          isFetching={isFetching}
          hasNextPage={Boolean(hasNextPage)}
          isFetchingNextPage={isFetchingNextPage}
          onFetchNextPage={() => void fetchNextPage()}
          onOpenEvidence={handleOpenEvidence}
          hasActiveFilters={
            (filter.dateScope && filter.dateScope !== 'today') ||
            Boolean(filter.mahallaName) ||
            Boolean(filter.lanes) ||
            Boolean(filter.search && filter.search.trim().length > 0)
          }
        />
      </Card>

      {/* Verbatim Evidence Inspection Drawer */}
      <DistrictTopicEvidenceDrawer
        open={drawerOpen}
        topic={selectedTopic}
        districtId={activeDistrictId}
        onClose={handleCloseEvidence}
        lastActiveElement={lastActiveElementRef.current}
      />
    </div>
  );
};
