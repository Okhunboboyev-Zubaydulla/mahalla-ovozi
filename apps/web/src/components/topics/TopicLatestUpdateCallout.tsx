import React from 'react';
import { Typography } from 'antd';
import { CommentOutlined } from '@ant-design/icons';
import { formatTashkentRelativeTime } from '../../lib/formatters.js';
import { HighlightText } from './HighlightText.js';

const { Text } = Typography;

export interface TopicLatestUpdateCalloutProps {
  latestUpdate?: string | null;
  evidenceCount: number;
  timestamp?: string | null;
  searchQuery?: string;
  style?: React.CSSProperties;
}

export const TopicLatestUpdateCallout: React.FC<TopicLatestUpdateCalloutProps> = ({
  latestUpdate,
  evidenceCount,
  timestamp,
  searchQuery,
  style,
}) => {
  // Gated: only display when topic has 2 or more messages and a meaningful latest update is present
  if (evidenceCount < 2 || !latestUpdate || latestUpdate.trim().length === 0) {
    return null;
  }

  const relativeTime = formatTashkentRelativeTime(timestamp);

  return (
    <div
      data-testid="topic-latest-update-callout"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        backgroundColor: '#F8FAFC',
        border: '1px solid #E2E8F0',
        borderLeft: '3px solid #0284C7',
        borderRadius: 6,
        padding: '6px 10px',
        marginTop: 2,
        boxSizing: 'border-box',
        ...style,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          lineHeight: '14px',
        }}
      >
        <CommentOutlined style={{ color: '#0284C7', fontSize: 11 }} />
        <Text strong style={{ fontSize: 11, color: '#0369A1' }}>
          Сўнгги хабар
        </Text>
        {relativeTime && (
          <Text style={{ fontSize: 11, color: '#64748B' }}>
            ({relativeTime})
          </Text>
        )}
      </div>

      <div
        style={{
          fontSize: 12.5,
          lineHeight: '17px',
          color: '#334155',
          fontStyle: 'italic',
          wordBreak: 'break-word',
        }}
      >
        <HighlightText text={latestUpdate} searchQuery={searchQuery} />
      </div>
    </div>
  );
};
