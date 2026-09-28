import React from 'react';
import { Tag } from 'antd';
import {
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { IssueSeverity } from '@mahalla-ovozi/api-contracts';

interface IssueSeverityBadgeProps {
  severity: IssueSeverity;
  className?: string;
  style?: React.CSSProperties;
}

interface SeverityConfig {
  label: string;
  color: 'error' | 'warning' | 'processing' | 'default';
  icon: React.ReactNode;
}

export const IssueSeverityBadge: React.FC<IssueSeverityBadgeProps> = ({
  severity,
  className,
  style,
}) => {
  const getConfig = (sev: IssueSeverity): SeverityConfig => {
    switch (sev) {
      case 'Critical':
        return {
          label: 'Муҳим',
          color: 'error',
          icon: <CloseCircleOutlined />,
        };
      case 'Warning':
        return {
          label: 'Огоҳлантириш',
          color: 'warning',
          icon: <ExclamationCircleOutlined />,
        };
      case 'Information':
        return {
          label: 'Маълумот',
          color: 'processing',
          icon: <InfoCircleOutlined />,
        };
      default:
        return {
          label: 'Маълумот',
          color: 'default',
          icon: <InfoCircleOutlined />,
        };
    }
  };

  const config = getConfig(severity);

  return (
    <Tag
      color={config.color}
      icon={config.icon}
      role="status"
      aria-label={`Муаммо даражаси: ${config.label}`}
      className={className}
      style={{
        fontWeight: 500,
        borderRadius: 4,
        padding: '2px 8px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        margin: 0,
        ...style,
      }}
    >
      {config.label}
    </Tag>
  );
};
