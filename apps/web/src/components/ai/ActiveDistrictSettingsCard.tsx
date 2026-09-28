import React from 'react';
import {
  Card,
  Descriptions,
  Badge,
  Tag,
  Typography,
  Collapse,
  theme,
  Alert,
} from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import type { DistrictAnalysisSettingsDto } from '@mahalla-ovozi/api-contracts';
import { formatTashkentTime } from '../../lib/formatters.js';

const { Text } = Typography;

interface ActiveDistrictSettingsCardProps {
  districtName: string;
  settings: DistrictAnalysisSettingsDto;
}

export const ActiveDistrictSettingsCard: React.FC<
  ActiveDistrictSettingsCardProps
> = ({ districtName, settings }) => {
  const { token } = theme.useToken();
  const hokimTerms = settings.hokimRecognitionTerms || [];
  const localVocab = settings.localVocabularyAdditions || [];

  return (
    <Card
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Text strong style={{ fontSize: 16 }}>
            Фаол туман созламалари
          </Text>
          <Badge
            count="Фаол созламалар"
            style={{
              backgroundColor: token.colorSuccess,
              color: '#fff',
              fontWeight: 500,
            }}
          />
        </div>
      }
      variant="outlined"
      style={{
        borderRadius: token.borderRadiusLG,
        marginBottom: 24,
        background: token.colorBgContainer,
      }}
    >
      <Alert
        message="Ҳозирги туман конфигурацияси"
        description="Ушбу туманга оид Ҳокимни таниш атамалари ва маҳаллий луғат жорий таҳлилда қўлланилмоқда. Қоралама сақланганда ушбу фаол созламалар ўзгармайди."
        type="info"
        showIcon
        icon={<InfoCircleOutlined />}
        style={{ marginBottom: 16, borderRadius: token.borderRadius }}
      />

      <Descriptions
        bordered
        size="small"
        column={{ xs: 1, sm: 2, md: 3, lg: 4 }}
        style={{ marginBottom: 16 }}
      >
        <Descriptions.Item label="Туман">
          <Text strong>{districtName}</Text>
        </Descriptions.Item>
        <Descriptions.Item label="Версия">
          <Tag color="blue">{settings.id}</Tag> (v{settings.version})
        </Descriptions.Item>
        <Descriptions.Item label="Фаоллаштирилган вақти">
          {formatTashkentTime(settings.activatedAt)}
        </Descriptions.Item>
        <Descriptions.Item label="Ҳолати">
          <Badge status="success" text="Фаол (Production)" />
        </Descriptions.Item>
      </Descriptions>

      <Collapse
        ghost
        size="small"
        defaultActiveKey={['hokimTerms', 'localVocab']}
        items={[
          {
            key: 'hokimTerms',
            label: (
              <Text strong>
                Ҳокимга оид атамалар ({hokimTerms.length} та)
              </Text>
            ),
            children: (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {hokimTerms.map((term, i) => (
                  <Tag key={`${term}-${i}`} color="cyan" style={{ fontSize: 13, padding: '2px 8px' }}>
                    {term}
                  </Tag>
                ))}
              </div>
            ),
          },
          {
            key: 'localVocab',
            label: (
              <Text strong>
                Қўшимча маҳаллий луғат ({localVocab.length} та)
              </Text>
            ),
            children: (
              <div>
                {localVocab.length === 0 ? (
                  <Text type="secondary">Маҳаллий қўшимча луғат киритилмаган.</Text>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {localVocab.map((item, i) => (
                      <Tag key={`${item.term}-${i}`} color="geekblue" style={{ fontSize: 13, padding: '2px 8px' }}>
                        {item.term} <Text type="secondary">({item.category})</Text>
                      </Tag>
                    ))}
                  </div>
                )}
              </div>
            ),
          },
        ]}
      />
    </Card>
  );
};
