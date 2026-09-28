import React from 'react';
import { Tag } from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  CloseCircleOutlined,
  PauseCircleOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import { HealthStatus } from '@mahalla-ovozi/api-contracts';

export interface HealthStatusBadgeProps {
  status: HealthStatus;
  size?: 'small' | 'middle';
  showIcon?: boolean;
  style?: React.CSSProperties;
  className?: string;
}

interface StatusConfig {
  label: string;
  color: string;
  icon: React.ReactNode;
}

const STATUS_CONFIG_MAP: Record<HealthStatus, StatusConfig> = {
  Healthy: {
    label: 'Соғлом',
    color: 'success',
    icon: <CheckCircleOutlined aria-hidden="true" />,
  },
  Delayed: {
    label: 'Кечиккан',
    color: 'warning',
    icon: <ClockCircleOutlined aria-hidden="true" />,
  },
  Degraded: {
    label: 'Қисман ишламоқда',
    color: 'orange',
    icon: <ExclamationCircleOutlined aria-hidden="true" />,
  },
  Unavailable: {
    label: 'Ишламаяпти',
    color: 'error',
    icon: <CloseCircleOutlined aria-hidden="true" />,
  },
  Quiet: {
    label: 'Фаолиятсиз',
    color: 'default',
    icon: <PauseCircleOutlined aria-hidden="true" />,
  },
  Unknown: {
    label: 'Номаълум',
    color: 'default',
    icon: <QuestionCircleOutlined aria-hidden="true" />,
  },
};

/**
 * Accessible health status badge combining Uzbek Cyrillic text and distinct icons (AC 4).
 * Enforces non-color-only encoding and accessible ARIA labels.
 */
export const HealthStatusBadge: React.FC<HealthStatusBadgeProps> = ({
  status,
  size = 'middle',
  showIcon = true,
  style,
  className,
}) => {
  const config = STATUS_CONFIG_MAP[status] || STATUS_CONFIG_MAP.Unknown;

  return (
    <Tag
      color={config.color}
      icon={showIcon ? config.icon : null}
      role="status"
      aria-label={`Ҳолат: ${config.label}`}
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontWeight: 500,
        fontSize: size === 'small' ? 12 : 13,
        padding: size === 'small' ? '1px 6px' : '3px 10px',
        borderRadius: 6,
        ...style,
      }}
    >
      {config.label}
    </Tag>
  );
};
