import React, { useState, useEffect } from 'react';
import { Skeleton, Typography } from 'antd';
import { ClockCircleOutlined } from '@ant-design/icons';
import { HighlightText } from './HighlightText.js';

const { Paragraph, Text } = Typography;

export interface TopicSummaryBodyProps {
  /** `null` means the projection has not been produced yet. */
  summary: string | null;
  createdAt: string;
  searchQuery?: string;
  style?: React.CSSProperties;
  fontSize?: number;
  lineHeight?: string;
  color?: string;
  fontWeight?: number;
  skeletonRows?: number;
}

function isOlderThan60Seconds(timestamp: string): boolean {
  const createdMs = new Date(timestamp).getTime();
  if (Number.isNaN(createdMs)) {
    return false;
  }
  return Date.now() - createdMs > 60_000;
}

export const TopicSummaryBody: React.FC<TopicSummaryBodyProps> = (props) => {
  const isPending = props.summary === null;
  const [isTimedOut, setIsTimedOut] = useState<boolean>(() => isOlderThan60Seconds(props.createdAt));

  useEffect(() => {
    if (!isPending) {
      return;
    }

    const createdMs = new Date(props.createdAt).getTime();
    if (Number.isNaN(createdMs)) {
      return;
    }

    const initialTimedOut = Date.now() - createdMs > 60_000;
    setIsTimedOut(initialTimedOut);

    if (initialTimedOut) {
      return;
    }

    const remainingMs = Math.max(0, 60_000 - (Date.now() - createdMs));
    const timer = setTimeout(() => {
      setIsTimedOut(true);
    }, remainingMs);

    return () => {
      clearTimeout(timer);
    };
  }, [isPending, props.createdAt]);

  if (isPending) {
    if (isTimedOut) {
      return (
        <div
          data-testid="topic-summary-delayed"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 8px',
            backgroundColor: '#FFFBEB',
            borderRadius: 6,
            border: '1px solid #FDE68A',
            ...props.style,
          }}
        >
          <ClockCircleOutlined style={{ color: '#D97706', fontSize: 13 }} />
          <Text
            style={{
              fontSize: props.fontSize ?? 13,
              color: '#B45309',
              fontStyle: 'italic',
              fontWeight: 500,
            }}
          >
            Мавзу хулосаси кечикмоқда (хабарлар мавжуд)
          </Text>
        </div>
      );
    }

    return (
      <div data-testid="topic-summary-skeleton" style={props.style}>
        <Skeleton
          active
          title={false}
          paragraph={{
            rows: props.skeletonRows ?? 2,
            width: ['100%', '75%'],
            style: { margin: 0 },
          }}
        />
      </div>
    );
  }

  return (
    <Paragraph
      data-testid="topic-summary-ready"
      style={{
        fontSize: props.fontSize ?? 14,
        lineHeight: props.lineHeight ?? '20px',
        fontWeight: props.fontWeight ?? 500,
        color: props.color ?? '#0F172A',
        margin: 0,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        ...props.style,
      }}
    >
      <HighlightText text={props.summary ?? ''} searchQuery={props.searchQuery} />
    </Paragraph>
  );
};
