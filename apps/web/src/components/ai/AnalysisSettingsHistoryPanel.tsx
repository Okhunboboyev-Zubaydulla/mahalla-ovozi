import React, { useState, useEffect } from 'react';
import {
  Card,
  Spin,
  Alert,
  Typography,
  Space,
  theme,
  message,
} from 'antd';
import {
  ReloadOutlined,
  EnvironmentOutlined,
} from '@ant-design/icons';
import {
  type DistrictAnalysisSettingsDto,
} from '@mahalla-ovozi/api-contracts';
import { useDistrict } from '../../district/district-context.js';
import { DistrictSelector } from '../DistrictSelector.js';
import {
  useDistrictAnalysisSettings,
  useDistrictAnalysisSettingsHistory,
  useRollbackDistrictSettings,
} from '../../hooks/useDistrictAnalysisSettings.js';
import { AnalysisSettingsHistoryTable } from './AnalysisSettingsHistoryTable.js';
import { AnalysisSettingsRollbackModal } from './AnalysisSettingsRollbackModal.js';

const { Title, Text, Paragraph } = Typography;

export const AnalysisSettingsHistoryPanel: React.FC = () => {
  const { token } = theme.useToken();
  const { activeDistrictId } = useDistrict();

  // Selected version for rollback review modal
  const [selectedTargetVersion, setSelectedTargetVersion] = useState<DistrictAnalysisSettingsDto | null>(null);

  useEffect(() => {
    setSelectedTargetVersion(null);
  }, [activeDistrictId]);

  // District Settings Data & History
  const {
    data: districtActiveData,
    refetch: refetchDistrictActive,
  } = useDistrictAnalysisSettings(activeDistrictId);

  const {
    data: districtHistoryData,
    isLoading: isDistrictHistoryLoading,
    isError: isDistrictHistoryError,
    error: districtHistoryError,
    refetch: refetchDistrictHistory,
  } = useDistrictAnalysisSettingsHistory(activeDistrictId);

  const rollbackDistrictMutation = useRollbackDistrictSettings(
    activeDistrictId || '',
  );

  const handleRollbackDistrictConfirm = async (changeReason: string) => {
    if (
      !activeDistrictId ||
      !districtActiveData?.activeConfiguration ||
      !selectedTargetVersion
    )
      return;
    const res = await rollbackDistrictMutation.mutateAsync({
      baseActiveVersionId: districtActiveData.activeConfiguration.id,
      targetVersionId: selectedTargetVersion.id,
      changeReason,
    });
    message.success(
      res.message ||
        `Туман созламалари V${selectedTargetVersion.version} ҳолатига янги V${res.activeConfiguration.version} версияси сифатида муваффақиятли қайтарилди.`,
    );
    void refetchDistrictActive();
    void refetchDistrictHistory();
  };

  if (!activeDistrictId) {
    return (
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
            Туман созламалари тарихини кўриш учун туманни танланг
          </Title>
          <Paragraph type="secondary">
            Ҳар бир туманнинг созламалар тарихи алоҳида сақланади ва бошқарилади.
          </Paragraph>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <DistrictSelector />
          </div>
        </Space>
      </Card>
    );
  }

  return (
    <div>
      {isDistrictHistoryLoading && (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <Space direction="vertical" size="middle">
            <Spin size="large" />
            <Text type="secondary">Туман созламалари тарихи юкланмоқда...</Text>
          </Space>
        </div>
      )}

      {isDistrictHistoryError && (
        <Alert
          message="Туман тарихини юклашда хатолик"
          description={
            districtHistoryError instanceof Error
              ? districtHistoryError.message
              : 'Туман созламалари тарихини олишнинг имкони бўлмади.'
          }
          type="error"
          showIcon
          action={
            <a
              onClick={() => refetchDistrictHistory()}
              style={{ cursor: 'pointer' }}
            >
              <ReloadOutlined /> Қайта уриниш
            </a>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      {districtHistoryData && (
        <Card
          size="small"
          title={
            <Text strong>
              {districtHistoryData.districtName} ({districtHistoryData.districtId})
            </Text>
          }
          style={{
            borderRadius: token.borderRadiusLG,
            background: token.colorBgContainer,
          }}
        >
          <AnalysisSettingsHistoryTable
            items={districtHistoryData.items}
            loading={isDistrictHistoryLoading}
            onRollbackClick={(target) => setSelectedTargetVersion(target)}
          />
        </Card>
      )}

      {/* Rollback Modal for District */}
      {selectedTargetVersion &&
        (districtActiveData?.activeConfiguration ||
          districtHistoryData?.items?.find((v) => v.isActive)) && (
          <AnalysisSettingsRollbackModal
            open={true}
            districtId={activeDistrictId}
            districtName={
              districtActiveData?.districtName ||
              districtHistoryData?.districtName ||
              activeDistrictId
            }
            activeVersion={
              districtActiveData?.activeConfiguration ||
              districtHistoryData!.items.find((v) => v.isActive)!
            }
            targetVersion={selectedTargetVersion}
            onConfirm={handleRollbackDistrictConfirm}
            onCancel={() => setSelectedTargetVersion(null)}
          />
        )}
    </div>
  );
};
