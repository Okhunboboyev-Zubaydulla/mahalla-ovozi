import React, { useState, useMemo } from 'react';
import {
  Tabs,
  Typography,
  Card,
  Spin,
  Alert,
  theme,
  Space,
  Button,
} from 'antd';
import {
  ApartmentOutlined,
  HistoryOutlined,
  DashboardOutlined,
  ReloadOutlined,
  EnvironmentOutlined,
} from '@ant-design/icons';
import { useDistrict } from '../district/district-context.js';
import { DistrictSelector } from '../components/DistrictSelector.js';
import { useDistrictAnalysisSettings } from '../hooks/useDistrictAnalysisSettings.js';
import { ActiveDistrictSettingsCard } from '../components/ai/ActiveDistrictSettingsCard.js';
import { DistrictSettingsDraftForm } from '../components/ai/DistrictSettingsDraftForm.js';
import { AnalysisSettingsHistoryPanel } from '../components/ai/AnalysisSettingsHistoryPanel.js';
import { SignalMonitoringTable } from '../components/ai/SignalMonitoringTable.js';

const { Title, Text, Paragraph } = Typography;

export const AiOperationsPage: React.FC = () => {
  const { token } = theme.useToken();
  const { activeDistrictId, attemptTransition } = useDistrict();
  const [activeTabKey, setActiveTabKey] = useState<string>('monitoring');

  const {
    data: districtSettingsData,
    isLoading: isDistrictLoading,
    isError: isDistrictError,
    error: districtError,
    refetch: refetchDistrict,
  } = useDistrictAnalysisSettings(activeDistrictId);

  const handleTabChange = (nextKey: string) => {
    if (nextKey === activeTabKey) return;
    attemptTransition(() => {
      setActiveTabKey(nextKey);
    });
  };

  const tabItems = useMemo(
    () => [
      {
        key: 'monitoring',
        label: (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <DashboardOutlined />
            Операциялар мониторинги
          </span>
        ),
        children: <SignalMonitoringTable initialDistrictId={activeDistrictId} />,
      },
      {
        key: 'district',
        label: (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ApartmentOutlined />
            Туман созламалари
          </span>
        ),
        children: (
          <div>
            {!activeDistrictId ? (
              <Card
                variant="outlined"
                style={{
                  borderRadius: token.borderRadiusLG,
                  background: token.colorBgContainer,
                  textAlign: 'center',
                  padding: '32px 16px',
                }}
              >
                <Space direction="vertical" size="middle" style={{ maxWidth: 500 }}>
                  <EnvironmentOutlined
                    style={{ fontSize: 48, color: token.colorPrimary }}
                  />
                  <Title level={4} style={{ margin: 0 }}>
                    Туман созламаларини кўриш ва таҳрирлаш учун аввал туманни танланг
                  </Title>
                  <Paragraph type="secondary">
                    Ҳокимни таниш атамалари ва маҳаллий луғат ҳар бир туман учун алоҳида сақланади ва бошқарилади.
                  </Paragraph>
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <DistrictSelector />
                  </div>
                </Space>
              </Card>
            ) : (
              <div>
                {isDistrictLoading && (
                  <div style={{ textAlign: 'center', padding: '40px 0' }}>
                    <Spin size="large" tip="Туман созламалари юкланмоқда..." />
                  </div>
                )}

                {isDistrictError && (
                  <Alert
                    message="Туман созламаларини юклашда хатолик"
                    description={
                      districtError instanceof Error
                        ? districtError.message
                        : 'Маълумотларни сервердан олишнинг имкони бўлмади.'
                    }
                    type="error"
                    showIcon
                    action={
                      <Button
                        type="link"
                        icon={<ReloadOutlined />}
                        onClick={() => void refetchDistrict()}
                        style={{ padding: 0 }}
                      >
                        Қайта уриниш
                      </Button>
                    }
                    style={{ marginBottom: 16 }}
                  />
                )}

                {districtSettingsData && (
                  <div>
                    <ActiveDistrictSettingsCard
                      districtName={districtSettingsData.districtName}
                      settings={districtSettingsData.activeConfiguration}
                    />
                    <DistrictSettingsDraftForm
                      districtId={activeDistrictId}
                      districtName={districtSettingsData.districtName}
                      activeSettings={districtSettingsData.activeConfiguration}
                      draft={districtSettingsData.draft}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        ),
      },
      {
        key: 'history',
        label: (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <HistoryOutlined />
            Созламалар тарихи
          </span>
        ),
        children: <AnalysisSettingsHistoryPanel />,
      },
    ],
    [
      activeDistrictId,
      token,
      isDistrictLoading,
      isDistrictError,
      districtError,
      refetchDistrict,
      districtSettingsData,
    ]
  );

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>
          АИ операциялари ва созламалари
        </Title>
        <Text type="secondary">
          АИ операциялари мониторинги, туманларга хос атамалар ва таҳлил созламалари тарихини бошқариш.
        </Text>
      </div>

      <Tabs
        activeKey={activeTabKey}
        onChange={handleTabChange}
        items={tabItems}
        size="large"
        style={{ background: 'transparent' }}
      />
    </div>
  );
};

export default AiOperationsPage;

