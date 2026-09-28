import React from 'react';
import { Card, Typography, Row, Col, Space, Button, theme } from 'antd';
import { SyncOutlined, CheckCircleOutlined, ApartmentOutlined } from '@ant-design/icons';
import { OverallSystemHealthResponse } from '@mahalla-ovozi/api-contracts';
import { HealthStatusBadge } from './HealthStatusBadge.js';
import { formatTashkentDate } from '../../lib/formatters.js';

const { Text } = Typography;

export interface OverallHealthCardProps {
  data: OverallSystemHealthResponse;
  isFetching?: boolean;
  onRefresh?: () => void;
}

export const OverallHealthCard: React.FC<OverallHealthCardProps> = ({
  data,
  isFetching = false,
  onRefresh,
}) => {
  const { token } = theme.useToken();

  return (
    <Card
      variant="borderless"
      style={{
        borderRadius: 12,
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorderSecondary || '#E2EAE7'}`,
        marginBottom: 24,
      }}
      styles={{ body: { padding: '24px' } }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: 16,
          marginBottom: 20,
        }}
      >
        <Space direction="vertical" size={4}>
          <Text type="secondary" style={{ fontSize: 13, fontWeight: 500 }}>
            Умумий тизим ҳолати
          </Text>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
            <HealthStatusBadge status={data.status} size="middle" />
            <Text style={{ fontSize: 13, color: token.colorTextSecondary }}>
              Барча глобал ва туман хизматлари асосида
            </Text>
          </div>
        </Space>

        {onRefresh && (
          <Button
            icon={<SyncOutlined spin={isFetching} />}
            onClick={onRefresh}
            loading={isFetching}
            style={{ borderRadius: 6 }}
          >
            Янгилаш
          </Button>
        )}
      </div>

      <Row gutter={[24, 16]}>
        <Col xs={24} sm={12} md={6}>
          <div style={{ background: token.colorFillQuaternary, padding: '12px 16px', borderRadius: 8 }}>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              Сўнгги техник текширув
            </Text>
            <Text
              strong
              style={{
                fontSize: 14,
                fontVariantNumeric: 'tabular-nums',
                color: token.colorText,
              }}
            >
              {formatTashkentDate(data.lastCheckAt)}
            </Text>
          </div>
        </Col>

        <Col xs={24} sm={12} md={6}>
          <div style={{ background: token.colorFillQuaternary, padding: '12px 16px', borderRadius: 8 }}>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              Ҳисобланган вақт
            </Text>
            <Text
              strong
              style={{
                fontSize: 14,
                fontVariantNumeric: 'tabular-nums',
                color: token.colorText,
              }}
            >
              {formatTashkentDate(data.evaluatedAt)}
            </Text>
          </div>
        </Col>

        <Col xs={24} sm={12} md={6}>
          <div style={{ background: token.colorFillQuaternary, padding: '12px 16px', borderRadius: 8 }}>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              Жами туманлар
            </Text>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <ApartmentOutlined style={{ color: token.colorPrimary }} />
              <Text strong style={{ fontSize: 14, color: token.colorText }}>
                {data.totalDistricts} та туман
              </Text>
            </div>
          </div>
        </Col>

        <Col xs={24} sm={12} md={6}>
          <div style={{ background: token.colorFillQuaternary, padding: '12px 16px', borderRadius: 8 }}>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              Фаол туманлар
            </Text>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <CheckCircleOutlined style={{ color: token.colorSuccess || '#059669' }} />
              <Text strong style={{ fontSize: 14, color: token.colorText }}>
                {data.activeDistricts} та фаол
              </Text>
            </div>
          </div>
        </Col>
      </Row>
    </Card>
  );
};
