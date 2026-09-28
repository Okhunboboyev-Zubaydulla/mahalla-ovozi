import React from 'react';
import { Row, Col, Card, Typography, Space, theme } from 'antd';
import {
  ApartmentOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  CloseCircleOutlined,
  PauseCircleOutlined,
  QuestionCircleOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { District, HealthStatus } from '@mahalla-ovozi/api-contracts';
import { useSystemHealth } from '../health/useSystemHealth.js';
import { useOperationalIssues } from '../issues/useOperationalIssues.js';

const { Text } = Typography;

interface OverviewMetricCardsProps {
  districts: District[];
  loading?: boolean;
}

interface HealthCardConfig {
  value: string;
  subText: string;
  icon: React.ReactNode;
  iconBg: string;
}

export const OverviewMetricCards: React.FC<OverviewMetricCardsProps> = ({
  districts,
  loading = false,
}) => {
  const { token } = theme.useToken();
  const { data: healthData, isLoading: isHealthLoading } = useSystemHealth();
  const { data: issuesData, isLoading: isIssuesLoading } = useOperationalIssues();

  const totalDistricts = districts.length;
  const activeDistricts = districts.filter((d) => d.status === 'ACTIVE').length;
  const incompleteDistricts = districts.filter((d) => d.status === 'SETUP_INCOMPLETE').length;

  const getHealthCardConfig = (status?: HealthStatus): HealthCardConfig => {
    switch (status) {
      case 'Healthy':
        return {
          value: 'Соғлом',
          subText: 'Барча хизматлар тўлиқ ишламоқда',
          icon: <CheckCircleOutlined style={{ fontSize: 20, color: token.colorSuccess || '#059669' }} />,
          iconBg: token.colorSuccessBg || '#D1FAE5',
        };
      case 'Delayed':
        return {
          value: 'Кечиккан',
          subText: 'Айрим хизматларда кечикиш кузатилмоқда',
          icon: <ClockCircleOutlined style={{ fontSize: 20, color: token.colorWarning }} />,
          iconBg: token.colorWarningBg || '#FEF3C7',
        };
      case 'Degraded':
        return {
          value: 'Қисман ишламоқда',
          subText: 'Техник муаммолар мавжуд',
          icon: <ExclamationCircleOutlined style={{ fontSize: 20, color: '#FA8C16' }} />,
          iconBg: '#FFF7E6',
        };
      case 'Unavailable':
        return {
          value: 'Ишламаяпти',
          subText: 'Шошилинч чора кўриш зарур',
          icon: <CloseCircleOutlined style={{ fontSize: 20, color: token.colorError || '#DC2626' }} />,
          iconBg: '#FEE2E2',
        };
      case 'Quiet':
        return {
          value: 'Фаолиятсиз',
          subText: 'Сигналлар ҳозирча йўқ',
          icon: <PauseCircleOutlined style={{ fontSize: 20, color: token.colorTextSecondary }} />,
          iconBg: '#F3F4F6',
        };
      case 'Unknown':
        return {
          value: 'Номаълум',
          subText: 'Текширув маълумотлари етарли эмас',
          icon: <QuestionCircleOutlined style={{ fontSize: 20, color: token.colorTextSecondary }} />,
          iconBg: '#F3F4F6',
        };
      default:
        return {
          value: 'Барқарор',
          subText: 'Хизматлар ҳолати текширилмоқда',
          icon: <SafetyCertificateOutlined style={{ fontSize: 20, color: token.colorPrimary }} />,
          iconBg: '#E0F2FE',
        };
    }
  };

  const healthConfig = getHealthCardConfig(healthData?.status);
  const activeIssuesCount = issuesData?.totalActive ?? 0;
  const criticalIssuesCount = issuesData?.criticalCount ?? 0;

  const healthSubText =
    activeIssuesCount > 0
      ? `${activeIssuesCount} та фаол муаммо (${criticalIssuesCount} муҳим)`
      : healthConfig.subText;

  const cardItems = [
    {
      id: 'metric-total-districts',
      title: 'Жами туманлар',
      value: totalDistricts,
      subText: `${activeDistricts} та фаол • ${incompleteDistricts} та созланмоқда`,
      icon: <ApartmentOutlined style={{ fontSize: 20, color: token.colorPrimary }} />,
      iconBg: '#E0F2FE',
    },
    {
      id: 'metric-active-districts',
      title: 'Фаол туманлар',
      value: activeDistricts,
      subText: activeDistricts > 0 ? 'Сигналлар қабул қилинмоқда' : 'Ҳозирча фаол туман йўқ',
      icon: <CheckCircleOutlined style={{ fontSize: 20, color: token.colorSuccess || '#059669' }} />,
      iconBg: token.colorSuccessBg || '#D1FAE5',
    },
    {
      id: 'metric-incomplete-districts',
      title: 'Созлаш жараёнида',
      value: incompleteDistricts,
      subText: incompleteDistricts > 0 ? 'Тайёрлик босқичларида' : 'Барчаси созланган',
      icon: <ClockCircleOutlined style={{ fontSize: 20, color: token.colorWarning }} />,
      iconBg: token.colorWarningBg || '#FEF3C7',
    },
    {
      id: 'metric-system-health',
      title: 'Тизим ҳолати',
      value: healthConfig.value,
      subText: healthSubText,
      icon: healthConfig.icon,
      iconBg: healthConfig.iconBg,
      loading: isHealthLoading || isIssuesLoading,
    },
  ];

  return (
    <section aria-label="Тизимнинг асосий кўрсаткичлари" style={{ marginBottom: 24 }}>
      <Row gutter={[16, 16]}>
        {cardItems.map((item) => (
          <Col xs={24} sm={12} lg={6} key={item.id}>
            <Card
              loading={loading || item.loading}
              variant="borderless"
              style={{
                borderRadius: 12,
                height: '100%',
                background: token.colorBgContainer,
                border: `1px solid ${token.colorBorderSecondary || '#E2EAE7'}`,
              }}
              styles={{ body: { padding: '20px 24px' } }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <Space direction="vertical" size={4} style={{ flex: 1 }}>
                  <Text type="secondary" style={{ fontSize: 13, fontWeight: 500 }}>
                    {item.title}
                  </Text>
                  <div
                    style={{
                      fontSize: typeof item.value === 'number' ? 28 : 20,
                      fontWeight: 600,
                      color: token.colorText,
                      lineHeight: '34px',
                      marginTop: 2,
                    }}
                  >
                    {item.value}
                  </div>
                  <Text
                    type="secondary"
                    style={{
                      fontSize: 12,
                      marginTop: 4,
                      display: 'block',
                      color: token.colorTextSecondary,
                    }}
                  >
                    {item.subText}
                  </Text>
                </Space>

                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 10,
                    background: item.iconBg,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    marginLeft: 12,
                  }}
                  aria-hidden="true"
                >
                  {item.icon}
                </div>
              </div>
            </Card>
          </Col>
        ))}
      </Row>
    </section>
  );
};
