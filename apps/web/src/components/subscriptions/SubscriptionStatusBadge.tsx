import React from 'react';
import { Tag } from 'antd';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  StopOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import { SubscriptionStatus } from '@mahalla-ovozi/api-contracts';

export interface SubscriptionStatusBadgeProps {
  status: SubscriptionStatus;
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

const STATUS_CONFIG_MAP: Record<SubscriptionStatus, StatusConfig> = {
  ACTIVE: {
    label: 'Фаол',
    color: 'success',
    icon: <CheckCircleOutlined aria-hidden="true" />,
  },
  GRACE: {
    label: 'Имтиёзли давр (Grace)',
    color: 'warning',
    icon: <ExclamationCircleOutlined aria-hidden="true" />,
  },
  SUSPENDED: {
    label: 'Тўхтатилган (Suspended)',
    color: 'error',
    icon: <StopOutlined aria-hidden="true" />,
  },
  CANCELLED: {
    label: 'Бекор қилинган (Cancelled)',
    color: 'volcano',
    icon: <CloseCircleOutlined aria-hidden="true" />,
  },
  SETUP_INCOMPLETE: {
    label: 'Созлаш тугалланмаган',
    color: 'default',
    icon: <ClockCircleOutlined aria-hidden="true" />,
  },
};

/**
 * Accessible subscription lifecycle status badge combining Uzbek Cyrillic text and icons.
 * Enforces non-color-only encoding and accessible ARIA attributes.
 */
export const SubscriptionStatusBadge: React.FC<SubscriptionStatusBadgeProps> = ({
  status,
  size = 'middle',
  showIcon = true,
  style,
  className,
}) => {
  const config = STATUS_CONFIG_MAP[status] || STATUS_CONFIG_MAP.SETUP_INCOMPLETE;

  return (
    <Tag
      color={config.color}
      icon={showIcon ? config.icon : null}
      aria-label={`Обуна ҳолати: ${config.label}`}
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
