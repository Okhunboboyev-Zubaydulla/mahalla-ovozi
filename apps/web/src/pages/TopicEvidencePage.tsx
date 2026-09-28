import React, { useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Button, Typography, Tag, Space, Skeleton, Alert, Grid } from 'antd';
import {
  ArrowLeftOutlined,
  EnvironmentOutlined,
  ClockCircleOutlined,
  ReloadOutlined,
  MessageOutlined,
} from '@ant-design/icons';
import { useTopicEvidence } from '../topics/useTopicEvidence.js';
import { useTopicReadState } from '../hooks/useTopicReadState.js';
import { LANE_LABELS, LANE_STYLES } from '../components/topics/TopicCard.js';
import { EvidenceTimeline } from '../components/topics/EvidenceTimeline.js';
import { formatTashkentActivityTime } from '../lib/formatters.js';
import { TopicSummaryBody } from '../components/topics/TopicSummaryBody.js';
import { TopicLatestUpdateCallout } from '../components/topics/TopicLatestUpdateCallout.js';

const { Title, Text } = Typography;

export const TopicEvidencePage: React.FC = () => {
  const { topicId } = useParams<{ topicId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const screens = Grid.useBreakpoint();
  const isMobile = Boolean(screens.xs);
  const focusHokim = new URLSearchParams(location.search).get('focusHokim') === '1';

  const handleBack = () => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate({ pathname: '/', search: location.search });
    }
  };

  const {
    topic,
    anchorQuote,
    evidenceList,
    totalCount,
    isLoading,
    isError,
    error,
    isFetchingNextPage,
    isFetchNextPageError,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useTopicEvidence(topicId);

  const { markTopicAsRead } = useTopicReadState();

  useEffect(() => {
    if (topic) {
      markTopicAsRead(topic.id, topic.evidenceCount);
    }
  }, [topic, markTopicAsRead]);

  const formattedActivityTime = topic
    ? formatTashkentActivityTime(
        topic.latestMeaningfulActivityTimestamp,
        topic.calendarDay,
      )
    : '';

  const errorMessage =
    error instanceof Error ? error.message : 'Далилларни юклашда хатолик юз берди.';

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100%',
        maxWidth: '100vw',
        overflowX: 'hidden',
        backgroundColor: '#F4F6F8',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Top Navigation Bar */}
      <header
        style={{
          backgroundColor: '#FFFFFF',
          borderBottom: '1px solid #E2E8F0',
          padding: isMobile ? '10px 14px' : '12px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          position: 'sticky',
          top: 0,
          zIndex: 20,
          boxShadow: 'none',
          width: '100%',
          maxWidth: '100vw',
          boxSizing: 'border-box',
        }}
      >
        <Space size={10} style={{ minWidth: 0 }}>
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={handleBack}
            aria-label="Бош саҳифага қайтиш"
            style={{
              fontWeight: 600,
              fontSize: 14,
              color: '#0F172A',
              height: 38,
              padding: '4px 8px',
            }}
          >
            Орқага
          </Button>

          <Title
            level={4}
            style={{
              margin: 0,
              fontSize: isMobile ? 15 : 16,
              fontWeight: 700,
              color: '#0F172A',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            Мавзу далиллари
          </Title>
        </Space>
      </header>

      {/* Main Content Area */}
      <main
        style={{
          flex: 1,
          maxWidth: 720,
          width: '100%',
          margin: '0 auto',
          padding: isMobile ? '14px 12px 32px 12px' : '20px 16px 40px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          boxSizing: 'border-box',
        }}
      >
        {/* Loading Skeleton */}
        {isLoading && (
          <div
            style={{
              backgroundColor: '#FFFFFF',
              border: '1px solid #E2E8F0',
              borderRadius: 10,
              padding: isMobile ? '16px' : '24px',
              boxShadow: 'none',
              boxSizing: 'border-box',
              width: '100%',
            }}
          >
            <Skeleton active paragraph={{ rows: 8 }} />
          </div>
        )}

        {/* Error State */}
        {!isLoading && isError && !topic && (
          <div
            style={{
              backgroundColor: '#FFFFFF',
              border: '1px solid #E2E8F0',
              borderRadius: 10,
              padding: isMobile ? '24px 16px' : '32px 24px',
              textAlign: 'center',
              boxShadow: 'none',
              boxSizing: 'border-box',
              width: '100%',
            }}
          >
            <Alert
              type="error"
              showIcon
              message="Юклашда хатолик"
              description={errorMessage}
              style={{
                textAlign: 'left',
                backgroundColor: '#FEE2E2',
                borderColor: '#FECACA',
                marginBottom: 16,
                borderRadius: 8,
                boxShadow: 'none',
              }}
            />
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              onClick={() => refetch()}
              style={{ fontWeight: 600, borderRadius: 6, boxShadow: 'none' }}
            >
              Қайта уриниш
            </Button>
          </div>
        )}

        {/* Empty / Not Found State */}
        {!isLoading && !isError && !topic && (
          <div
            style={{
              backgroundColor: '#FFFFFF',
              border: '1px solid #E2E8F0',
              borderRadius: 10,
              padding: isMobile ? '24px 16px' : '32px 24px',
              textAlign: 'center',
              boxShadow: 'none',
              boxSizing: 'border-box',
              width: '100%',
            }}
          >
            <Alert
              type="info"
              showIcon
              message="Мавзу топилмади"
              description="Ушбу мавзу топилмади ёки сизнинг туманингизга тегишли эмас."
              style={{
                textAlign: 'left',
                backgroundColor: '#F0F9FF',
                borderColor: '#BAE6FD',
                marginBottom: 16,
                borderRadius: 8,
                boxShadow: 'none',
              }}
            />
            <Button
              type="default"
              onClick={handleBack}
              style={{ fontWeight: 600, borderRadius: 6, boxShadow: 'none' }}
            >
              Тахтага қайтиш
            </Button>
          </div>
        )}

        {/* Loaded Topic & Evidence Content */}
        {!isLoading && topic && (
          <>
            {/* Topic Summary Card */}
            <div
              style={{
                backgroundColor: '#FFFFFF',
                border: '1px solid #E2E8F0',
                borderRadius: 10,
                padding: isMobile ? '14px 14px' : '18px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                boxShadow: 'none',
                boxSizing: 'border-box',
                width: '100%',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                <Space size={6} style={{ minWidth: 0 }}>
                  <EnvironmentOutlined style={{ color: '#0284C7', fontSize: 15 }} />
                  <Text strong style={{ fontSize: 16, color: '#0F172A' }}>
                    {topic.mahallaName}
                  </Text>
                </Space>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {topic.lanes.map((lane) => {
                    const style = LANE_STYLES[lane] || LANE_STYLES.HOKIM_RELATED;
                    const label = LANE_LABELS[lane] || lane;
                    return (
                      <Tag
                        key={lane}
                        style={{
                          backgroundColor: style.bg,
                          color: style.text,
                          borderColor: style.border,
                          fontSize: 11,
                          fontWeight: 600,
                          margin: 0,
                          borderRadius: 4,
                        }}
                      >
                        {label}
                      </Tag>
                    );
                  })}
                </div>
              </div>

              <TopicSummaryBody
                summary={topic.summary}
                createdAt={topic.createdAt}
                fontSize={14}
                lineHeight="22px"
                color="#1E293B"
              />

              {/* Dynamic Contextual Latest Message Update */}
              <TopicLatestUpdateCallout
                latestUpdate={topic.latestUpdate}
                evidenceCount={topic.evidenceCount}
                timestamp={topic.latestMeaningfulActivityTimestamp}
              />

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 8,
                  paddingTop: 10,
                  borderTop: '1px solid #F1F5F9',
                  fontSize: 13,
                  color: '#64748B',
                  width: '100%',
                }}
              >
                <Space size={4}>
                  <MessageOutlined style={{ fontSize: 13, color: '#94A3B8' }} />
                  <Text style={{ fontSize: 13, color: '#64748B' }}>
                    Жами: <span style={{ fontWeight: 600, color: '#0F172A' }}>{totalCount}</span> та хабар
                  </Text>
                </Space>

                {formattedActivityTime && (
                  <Space size={4}>
                    <ClockCircleOutlined style={{ fontSize: 13, color: '#94A3B8' }} />
                    <Text style={{ fontSize: 13, color: '#64748B' }}>{formattedActivityTime}</Text>
                  </Space>
                )}
              </div>
            </div>

            {/* Anchor Quote Callout */}
            {anchorQuote && (
              <div
                style={{
                  backgroundColor: '#F0F9FF',
                  border: '1px solid #BAE6FD',
                  borderLeft: '4px solid #0284C7',
                  borderRadius: '0 8px 8px 0',
                  padding: isMobile ? '12px 14px' : '14px 16px',
                  boxShadow: 'none',
                  boxSizing: 'border-box',
                  width: '100%',
                }}
              >
                <Text
                  style={{
                    display: 'block',
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#0369A1',
                    marginBottom: 4,
                    textTransform: 'uppercase',
                    letterSpacing: '0.03em',
                  }}
                >
                  Дастлабки хабар иқтибоси:
                </Text>
                <Text
                  italic
                  style={{
                    fontSize: 14,
                    color: '#0C4A6E',
                    lineHeight: '20px',
                    display: 'block',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                    wordBreak: 'normal',
                  }}
                >
                  «{anchorQuote}»
                </Text>
              </div>
            )}

            {/* Evidence List Header */}
            <div>
              <Text
                strong
                style={{
                  fontSize: 15,
                  color: '#0F172A',
                  display: 'block',
                  marginBottom: 12,
                }}
              >
                Сақланган далиллар рўйхати ({evidenceList.length} / {totalCount})
              </Text>

              {/* Chronological Evidence Timeline */}
              <EvidenceTimeline
                evidenceList={evidenceList}
                totalCount={totalCount}
                hasNextPage={hasNextPage}
                isFetchingNextPage={isFetchingNextPage}
                isFetchNextPageError={isFetchNextPageError}
                onFetchNextPage={fetchNextPage}
                focusHokim={focusHokim}
              />
            </div>
          </>
        )}
      </main>
    </div>
  );
};
