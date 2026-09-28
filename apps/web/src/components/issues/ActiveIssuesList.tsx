import React from 'react';
import { Card, List, Button, Typography, Space, Empty, theme, Badge, Popconfirm } from 'antd';
import {
  RightOutlined,
  CheckCircleTwoTone,
  ClockCircleOutlined,
  GlobalOutlined,
  BankOutlined,
  ReloadOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { OperationalIssue } from '@mahalla-ovozi/api-contracts';
import { IssueSeverityBadge } from './IssueSeverityBadge.js';
import { formatIssueDuration } from '../../utils/duration-format.js';
import { useRetryOperationalIssue } from '../../issues/useOperationalIssues.js';

const { Text, Title, Paragraph } = Typography;

interface ActiveIssuesListProps {
  issues: OperationalIssue[];
  loading?: boolean;
  onSelectIssue: (issue: OperationalIssue, triggerEl: HTMLElement | null) => void;
}

export const ActiveIssuesList: React.FC<ActiveIssuesListProps> = ({
  issues,
  loading = false,
  onSelectIssue,
}) => {
  const { token } = theme.useToken();
  const retryMutation = useRetryOperationalIssue();

  return (
    <Card
      style={{
        borderRadius: 12,
        marginBottom: 24,
        border: `1px solid ${token.colorBorderSecondary || '#E2EAE7'}`,
      }}
      styles={{ body: { padding: '20px 24px' } }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}
      >
        <Space align="center" size={8}>
          <Title level={4} style={{ margin: 0, fontWeight: 600 }}>
            Фаол техник муаммолар
          </Title>
          {issues.length > 0 && (
            <Badge
              count={issues.length}
              style={{
                backgroundColor: token.colorError,
                fontWeight: 600,
              }}
            />
          )}
        </Space>
      </div>

      {issues.length === 0 ? (
        <Empty
          image={
            <CheckCircleTwoTone
              twoToneColor={token.colorSuccess || '#52c41a'}
              style={{ fontSize: 48, marginTop: 12 }}
            />
          }
          styles={{ image: { height: 60 } }}
          description={
            <div style={{ marginTop: 8 }}>
              <Text strong style={{ fontSize: 15, display: 'block' }}>
                Фаол техник муаммолар мавжуд эмас
              </Text>
              <Text type="secondary" style={{ fontSize: 13 }}>
                Барча тизим ва туман хизматлари барқарор ишламоқда
              </Text>
            </div>
          }
          style={{ padding: '24px 0' }}
        />
      ) : (
        <List
          loading={loading}
          dataSource={issues}
          itemLayout="vertical"
          renderItem={(issue) => {
            const isGlobal = issue.scope === 'GLOBAL';
            const locationText = isGlobal
              ? 'Глобал тизим'
              : issue.districtName || 'Туман хизмати';

            return (
              <List.Item
                key={issue.id}
                style={{
                  padding: '16px 20px',
                  marginBottom: 12,
                  background: token.colorBgContainer,
                  border: `1px solid ${
                    issue.severity === 'Critical'
                      ? '#FFA39E'
                      : issue.severity === 'Warning'
                        ? '#FFE58F'
                        : token.colorBorderSecondary || '#E2EAE7'
                  }`,
                  borderRadius: 8,
                  transition: 'all 0.2s ease',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 12,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 260 }}>
                    <Space size={8} wrap style={{ marginBottom: 6 }}>
                      <IssueSeverityBadge severity={issue.severity} />
                      <TagItem
                        icon={isGlobal ? <GlobalOutlined /> : <BankOutlined />}
                        text={locationText}
                      />
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        <ClockCircleOutlined style={{ marginRight: 4 }} />
                        {formatIssueDuration(issue.startedAt)}
                      </Text>
                    </Space>

                    <div style={{ marginTop: 4 }}>
                      <Text strong style={{ fontSize: 15, color: token.colorText }}>
                        {issue.sanitizedTitle}
                      </Text>
                    </div>

                    <Paragraph
                      type="secondary"
                      style={{
                        marginTop: 4,
                        marginBottom: 0,
                        fontSize: 13,
                        lineHeight: '20px',
                      }}
                    >
                      <Text strong style={{ color: token.colorTextSecondary }}>
                        Тавсия:
                      </Text>{' '}
                      {issue.recommendedAction}
                    </Paragraph>
                  </div>

                  <div style={{ alignSelf: 'center' }}>
                    <Space size={8}>
                      {issue.isRetryEligible && (
                        <div onClick={(e) => e.stopPropagation()}>
                          <Popconfirm
                            title="Қайта ижро этишни тасдиқлайсизми?"
                            description="Ушбу амалиёт хавфсиз навбат орқали қайта ишга туширилади."
                            okText="Ҳа, қайта ижро этиш"
                            cancelText="Бекор қилиш"
                            disabled={
                              issue.pendingRetry ||
                              (retryMutation.isPending &&
                                retryMutation.variables?.issueId === issue.id)
                            }
                            okButtonProps={{
                              loading:
                                retryMutation.isPending &&
                                retryMutation.variables?.issueId === issue.id,
                            }}
                            onConfirm={() => {
                              retryMutation.mutate({ issueId: issue.id });
                            }}
                          >
                            <Button
                              type="default"
                              size="middle"
                              icon={
                                issue.pendingRetry ? (
                                  <SyncOutlined spin />
                                ) : (
                                  <ReloadOutlined />
                                )
                              }
                              disabled={
                                issue.pendingRetry ||
                                (retryMutation.isPending &&
                                  retryMutation.variables?.issueId === issue.id)
                              }
                              loading={
                                retryMutation.isPending &&
                                retryMutation.variables?.issueId === issue.id
                              }
                              aria-label={`${issue.sanitizedTitle} бўйича қайта ижро этиш`}
                            >
                              {issue.pendingRetry
                                ? 'Қайта ижро этилмоқда...'
                                : 'Қайта уриниш'}
                            </Button>
                          </Popconfirm>
                        </div>
                      )}

                      <Button
                        type="primary"
                        ghost
                        size="middle"
                        onClick={(e) => onSelectIssue(issue, e.currentTarget)}
                        aria-haspopup="dialog"
                        aria-controls="issue-detail-drawer"
                        aria-label={`${issue.sanitizedTitle} бўйича батафсил маълумот`}
                      >
                        Батафсил <RightOutlined />
                      </Button>
                    </Space>
                  </div>
                </div>
              </List.Item>
            );
          }}
        />
      )}
    </Card>
  );
};

const TagItem: React.FC<{ icon: React.ReactNode; text: string }> = ({
  icon,
  text,
}) => {
  const { token } = theme.useToken();
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 12,
        padding: '2px 8px',
        borderRadius: 4,
        background: token.colorFillAlter,
        color: token.colorTextSecondary,
        border: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      {icon}
      {text}
    </span>
  );
};
