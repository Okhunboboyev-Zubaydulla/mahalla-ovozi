import React, { useMemo } from 'react';
import {
  Drawer,
  Typography,
  Tag,
  Space,
  Card,
  Grid,
  Spin,
  Alert,
  theme,
  Button,
} from 'antd';
import {
  ClockCircleOutlined,
  EnvironmentOutlined,
  CalendarOutlined,
  MessageOutlined,
  CloseOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import {
  TopicCardItem,
  QualifyingLane,
} from '@mahalla-ovozi/api-contracts';
import { useDistrictTopicEvidence } from '../../../topics/index.js';
import { formatTashkentActivityTime } from '../../../lib/formatters.js';
import { LANE_LABELS, LANE_STYLES } from '../../topics/TopicCard.js';
import { EvidenceTimeline } from '../../topics/EvidenceTimeline.js';
import { TopicSummaryBody } from '../../topics/TopicSummaryBody.js';

const { Text, Paragraph } = Typography;

export interface DistrictTopicEvidenceDrawerProps {
  open: boolean;
  topic: TopicCardItem | null;
  districtId: string | null;
  onClose: () => void;
  lastActiveElement?: HTMLElement | null;
}

export const DistrictTopicEvidenceDrawer: React.FC<DistrictTopicEvidenceDrawerProps> = ({
  open,
  topic,
  districtId,
  onClose,
  lastActiveElement,
}) => {
  const screens = Grid.useBreakpoint();
  const { token } = theme.useToken();

  const topicId = topic?.id || null;

  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useDistrictTopicEvidence(open ? districtId : null, open ? topicId : null);

  // Restore keyboard focus when drawer closes
  const handleClose = () => {
    onClose();
    if (lastActiveElement && typeof lastActiveElement.focus === 'function') {
      setTimeout(() => {
        lastActiveElement.focus();
      }, 50);
    }
  };

  const evidenceList = useMemo(() => {
    if (!data?.pages) return [];
    return data.pages.flatMap((page) => page.evidence);
  }, [data]);

  const totalCount = data?.pages[0]?.totalCount ?? (topic?.evidenceCount || 0);
  const anchorQuote = data?.pages[0]?.anchorQuote;

  const drawerTitle = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <FileTextOutlined style={{ color: '#0284C7' }} />
      <span>Мавзу тафсилотлари ва далиллар</span>
    </div>
  );

  return (
    <Drawer
      open={open}
      onClose={handleClose}
      title={drawerTitle}
      destroyOnClose
      closable={false}
      width={screens.md ? 640 : '100%'}
      styles={{
        body: {
          padding: 20,
          backgroundColor: token.colorBgLayout,
        },
      }}
      extra={
        <Button
          type="text"
          icon={<CloseOutlined />}
          onClick={handleClose}
          aria-label="Ёпиш"
        />
      }
      aria-label="Мавзу далиллари"
    >
      {topic && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Topic Summary Card */}
          <Card
            variant="borderless"
            style={{
              borderRadius: 8,
              backgroundColor: token.colorBgContainer,
              border: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            <div style={{ marginTop: 0, marginBottom: 8 }}>
              <TopicSummaryBody
                summary={topic.summary}
                createdAt={topic.createdAt}
                fontSize={16}
                lineHeight="24px"
                fontWeight={600}
                color="#0F172A"
              />
            </div>

            <Space wrap size={[8, 8]} style={{ marginBottom: 12 }}>
              {/* Mahalla */}
              <Space size={4} style={{ fontSize: 13, color: '#334155' }}>
                <EnvironmentOutlined style={{ color: '#64748B' }} />
                <Text strong>{topic.mahallaName}</Text>
              </Space>

              {/* Calendar Day */}
              <Space size={4} style={{ fontSize: 13, color: '#64748B' }}>
                <CalendarOutlined />
                <span>{topic.calendarDay}</span>
              </Space>

              {/* Activity Timestamp */}
              <Space size={4} style={{ fontSize: 13, color: '#64748B' }}>
                <ClockCircleOutlined />
                <span>
                  {formatTashkentActivityTime(
                    topic.latestMeaningfulActivityTimestamp,
                    topic.calendarDay,
                  )}
                </span>
              </Space>

              {/* Evidence Count */}
              <Space size={4} style={{ fontSize: 13, color: '#64748B' }}>
                <MessageOutlined />
                <span>{totalCount} та далил</span>
              </Space>
            </Space>

            {/* Lanes Tags */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {(topic.lanes || []).map((lane: QualifyingLane) => {
                const style = LANE_STYLES[lane] || {
                  bg: '#F1F5F9',
                  text: '#475569',
                  border: '#E2E8F0',
                };
                return (
                  <Tag
                    key={lane}
                    style={{
                      backgroundColor: style.bg,
                      color: style.text,
                      borderColor: style.border,
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: 600,
                      margin: 0,
                    }}
                  >
                    {LANE_LABELS[lane] || lane}
                  </Tag>
                );
              })}
            </div>
          </Card>

          {/* Anchor Quote Card (if present) */}
          {anchorQuote && (
            <Card
              variant="borderless"
              style={{
                borderRadius: 8,
                backgroundColor: '#EFF6FF',
                border: '1px solid #BFDBFE',
              }}
            >
              <Text strong style={{ color: '#1E40AF', fontSize: 13, display: 'block', marginBottom: 4 }}>
                Дастлабки хабар иқтибоси:
              </Text>
              <Paragraph
                style={{
                  margin: 0,
                  fontSize: 13,
                  color: '#1E3A8A',
                  fontStyle: 'italic',
                }}
              >
                «{anchorQuote}»
              </Paragraph>
            </Card>
          )}

          {/* Loading / Error States */}
          {isLoading && evidenceList.length === 0 && (
            <div style={{ padding: '40px 0', textAlign: 'center' }}>
              <Space direction="vertical" align="center" size={8}>
                <Spin size="default" />
                <Text type="secondary" style={{ fontSize: 13 }}>
                  Далиллар юкланмоқда...
                </Text>
              </Space>
            </div>
          )}

          {isError && (
            <Alert
              type="error"
              showIcon
              message="Далилларни юклаб бўлмади"
              description={error?.message || 'Сервер билан алоқада хатолик юз берди.'}
              action={
                <Button size="small" type="primary" danger onClick={() => refetch()}>
                  Қайта уриниш
                </Button>
              }
            />
          )}

          {/* Chronological Evidence Timeline */}
          {!isLoading && !isError && (
            <div>
              <Text strong style={{ fontSize: 14, color: '#334155', display: 'block', marginBottom: 12 }}>
                Хронологик далиллар кетма-кетлиги ({evidenceList.length} та кўрсатилмоқда):
              </Text>
              <EvidenceTimeline
                evidenceList={evidenceList}
                totalCount={totalCount}
                hasNextPage={Boolean(hasNextPage)}
                isFetchingNextPage={isFetchingNextPage}
                isFetchNextPageError={isFetchNextPageError}
                onFetchNextPage={() => void fetchNextPage()}
              />
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
};
