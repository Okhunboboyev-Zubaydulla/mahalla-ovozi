import React, { useRef } from 'react';
import {
  Drawer,
  Typography,
  Space,
  Descriptions,
  Button,
  Timeline,
  Divider,
  Alert,
  theme,
  Spin,
  Popconfirm,
} from 'antd';
import {
  CloseOutlined,
  ArrowRightOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  ClockCircleOutlined,
  ReloadOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { OperationalIssue } from '@mahalla-ovozi/api-contracts';
import { IssueSeverityBadge } from './IssueSeverityBadge.js';
import {
  useOperationalIssueDetail,
  useRetryOperationalIssue,
} from '../../issues/useOperationalIssues.js';
import { formatIssueDuration } from '../../utils/duration-format.js';

const { Title, Text, Paragraph } = Typography;

interface IssueDetailDrawerProps {
  issue: OperationalIssue | null;
  open: boolean;
  onClose: () => void;
  openerRef?: React.RefObject<HTMLElement | null>;
}

export const IssueDetailDrawer: React.FC<IssueDetailDrawerProps> = ({
  issue,
  open,
  onClose,
  openerRef,
}) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryMutation = useRetryOperationalIssue();

  const { data: detailData, isLoading: isDetailLoading } =
    useOperationalIssueDetail(issue?.id || null);

  const currentIssue = detailData?.issue || issue;
  const auditEvents = detailData?.auditEvents || [];

  // Focus management: after open, focus drawer title; on close, restore focus to opener (Story 4.2 AC 16)
  const handleAfterOpenChange = (isOpen: boolean) => {
    if (isOpen) {
      headingRef.current?.focus();
    } else {
      if (openerRef?.current && typeof openerRef.current.focus === 'function' && document.body.contains(openerRef.current)) {
        openerRef.current.focus();
      }
    }
  };

  const handleActionNavigate = (route: string) => {
    onClose();
    navigate(route);
  };

  const getActionBtnLabel = (route: string | null): string => {
    if (!route) return '';
    if (route.includes('/telegram-setup')) {
      return 'Бот созламаларига ўтиш';
    }
    if (route.includes('/subscriptions')) {
      return 'Обуна саҳифасига ўтиш';
    }
    return 'Созламаларга ўтиш';
  };

  return (
    <Drawer
      id="issue-detail-drawer"
      aria-labelledby="issue-detail-drawer-title"
      open={open}
      onClose={onClose}
      closable={false}
      afterOpenChange={handleAfterOpenChange}
      placement="right"
      width={typeof window !== 'undefined' && window.innerWidth < 768 ? '100%' : 560}
      mask={false}
      destroyOnClose
      keyboard
      styles={{
        header: {
          padding: '16px 24px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        },
        body: {
          padding: '20px 24px',
        },
      }}
      title={
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
          }}
        >
          <Title
            ref={headingRef}
            tabIndex={-1}
            id="issue-detail-drawer-title"
            level={4}
            style={{
              margin: 0,
              fontSize: 16,
              fontWeight: 600,
              outline: 'none',
            }}
          >
            Муаммо тафсилотлари
          </Title>
        </div>
      }
      extra={
        <Button
          type="text"
          icon={<CloseOutlined />}
          onClick={onClose}
          aria-label="Муаммо тафсилотлари панелидан чиқиш"
        />
      }
    >
      {currentIssue && (
        <div>
          {/* Header Badge and Title */}
          <div style={{ marginBottom: 20 }}>
            <Space size={8} style={{ marginBottom: 8 }}>
              <IssueSeverityBadge severity={currentIssue.severity} />
              <Text type="secondary" style={{ fontSize: 13 }}>
                <ClockCircleOutlined style={{ marginRight: 4 }} />
                {formatIssueDuration(currentIssue.startedAt)}
              </Text>
            </Space>

            <Title level={4} style={{ marginTop: 4, marginBottom: 8, fontWeight: 600 }}>
              {currentIssue.sanitizedTitle}
            </Title>

            <Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 14 }}>
              {currentIssue.sanitizedDescription}
            </Paragraph>
          </div>

          {/* Recommended Action Card */}
          <Alert
            message="Тавсия этилган ҳаракат"
            description={
              <div>
                <Paragraph style={{ marginBottom: currentIssue.targetRoute || currentIssue.isRetryEligible ? 12 : 0 }}>
                  {currentIssue.recommendedAction}
                </Paragraph>
                <Space size={8} wrap>
                  {currentIssue.isRetryEligible && (
                    <Popconfirm
                      title="Қайта ижро этишни тасдиқлайсизми?"
                      description="Ушбу амалиёт хавфсиз навбат орқали қайта ишга туширилади."
                      okText="Ҳа, қайта ижро этиш"
                      cancelText="Бекор қилиш"
                      disabled={
                        currentIssue.pendingRetry ||
                        (retryMutation.isPending &&
                          retryMutation.variables?.issueId === currentIssue.id)
                      }
                      okButtonProps={{
                        loading:
                          retryMutation.isPending &&
                          retryMutation.variables?.issueId === currentIssue.id,
                      }}
                      onConfirm={() => {
                        retryMutation.mutate({ issueId: currentIssue.id });
                      }}
                    >
                      <Button
                        type="primary"
                        ghost
                        size="middle"
                        icon={
                          currentIssue.pendingRetry ? (
                            <SyncOutlined spin />
                          ) : (
                            <ReloadOutlined />
                          )
                        }
                        disabled={
                          currentIssue.pendingRetry ||
                          (retryMutation.isPending &&
                            retryMutation.variables?.issueId === currentIssue.id)
                        }
                        loading={
                          retryMutation.isPending &&
                          retryMutation.variables?.issueId === currentIssue.id
                        }
                        aria-label="Муаммони қайта ижро этиш"
                      >
                        {currentIssue.pendingRetry
                          ? 'Қайта ижро этилмоқда...'
                          : 'Қайта уриниш'}
                      </Button>
                    </Popconfirm>
                  )}

                  {currentIssue.targetRoute && (
                    <Button
                      type="primary"
                      size="middle"
                      icon={<ArrowRightOutlined />}
                      onClick={() => handleActionNavigate(currentIssue.targetRoute!)}
                    >
                      {getActionBtnLabel(currentIssue.targetRoute)}
                    </Button>
                  )}
                </Space>
              </div>
            }
            type={
              currentIssue.severity === 'Critical'
                ? 'error'
                : currentIssue.severity === 'Warning'
                  ? 'warning'
                  : 'info'
            }
            showIcon
            style={{
              borderRadius: 8,
              marginBottom: 24,
            }}
          />

          {/* Diagnostic Details */}
          <Title level={5} style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
            Техник кўрсаткичлар
          </Title>

          <Descriptions
            column={1}
            size="small"
            bordered
            style={{
              marginBottom: 24,
              borderRadius: 8,
              overflow: 'hidden',
            }}
            items={[
              {
                key: 'scope',
                label: 'Қамров',
                children:
                  currentIssue.scope === 'GLOBAL'
                    ? 'Глобал тизим'
                    : 'Туман даражасида',
              },
              ...(currentIssue.districtName
                ? [
                    {
                      key: 'district',
                      label: 'Тегишли туман',
                      children: currentIssue.districtName,
                    },
                  ]
                : []),
              {
                key: 'component',
                label: 'Компонент',
                children: <Text code>{currentIssue.component}</Text>,
              },
              {
                key: 'category',
                label: 'Хатолик тоифаси',
                children: <Text code>{currentIssue.issueCategory}</Text>,
              },
              {
                key: 'startedAt',
                label: 'Аниқланган вақт',
                children: new Date(currentIssue.startedAt).toLocaleString(
                  'uz-UZ',
                  {
                    timeZone: 'Asia/Tashkent',
                  },
                ),
              },
              {
                key: 'latestCheckAt',
                label: 'Охирги текширув',
                children: new Date(currentIssue.latestCheckAt).toLocaleString(
                  'uz-UZ',
                  {
                    timeZone: 'Asia/Tashkent',
                  },
                ),
              },
              ...(currentIssue.resolvedAt
                ? [
                    {
                      key: 'resolvedAt',
                      label: 'Бараф этилган вақт',
                      children: new Date(currentIssue.resolvedAt).toLocaleString(
                        'uz-UZ',
                        {
                          timeZone: 'Asia/Tashkent',
                        },
                      ),
                    },
                  ]
                : []),
            ]}
          />

          {/* Audit Event Timeline */}
          <Divider style={{ margin: '20px 0' }} />

          <Title level={5} style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>
            Ҳолат ўзгаришлари тарихи
          </Title>

          {isDetailLoading ? (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <Spin />
              <div style={{ marginTop: 8 }}>
                <Text type="secondary" style={{ fontSize: 13 }}>
                  Тарих юкланмоқда...
                </Text>
              </div>
            </div>
          ) : auditEvents.length === 0 ? (
            <Text type="secondary" style={{ fontSize: 13 }}>
              Ҳолат тарихи мавжуд эмас.
            </Text>
          ) : (
            <Timeline
              items={auditEvents.map((evt) => {
                const isDetected = evt.action === 'OPERATIONAL_ISSUE_DETECTED';
                const isRetry = evt.action === 'OPERATIONAL_RETRY_TRIGGERED';
                const isResolved = evt.action === 'OPERATIONAL_ISSUE_RESOLVED';

                const color = isDetected ? 'red' : isRetry ? 'blue' : isResolved ? 'green' : 'gray';
                const dot = isDetected ? (
                  <WarningOutlined style={{ fontSize: 14 }} />
                ) : isRetry ? (
                  <SyncOutlined style={{ fontSize: 14 }} />
                ) : (
                  <CheckCircleOutlined style={{ fontSize: 14 }} />
                );

                const eventTitle = isDetected
                  ? 'Муаммо қайд этилди'
                  : isRetry
                    ? 'Қайта ижро этиш сўралди'
                    : isResolved
                      ? 'Муаммо бартараф этилди'
                      : evt.action;

                const actorText = evt.actorRole === 'PRODUCT_OWNER'
                  ? 'Маҳсулот эгаси'
                  : evt.actorId || 'Тизим';

                const reason = evt.metadata?.reason ? String(evt.metadata.reason) : null;

                return {
                  key: evt.id,
                  color,
                  dot,
                  children: (
                    <div>
                      <Text strong style={{ fontSize: 13 }}>
                        {eventTitle}
                      </Text>
                      <br />
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {new Date(evt.createdAt).toLocaleString('uz-UZ', {
                          timeZone: 'Asia/Tashkent',
                        })}
                      </Text>
                      {evt.actorId && (
                        <div style={{ marginTop: 2 }}>
                          <Text type="secondary" style={{ fontSize: 11 }}>
                            Манба: <Text code style={{ fontSize: 11 }}>{actorText}</Text>
                          </Text>
                        </div>
                      )}
                      {reason && (
                        <div style={{ marginTop: 2 }}>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            Сабаб: {reason}
                          </Text>
                        </div>
                      )}
                    </div>
                  ),
                };
              })}
            />
          )}
        </div>
      )}
    </Drawer>
  );
};
