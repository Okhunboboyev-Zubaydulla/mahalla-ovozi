import React from 'react';
import {
  Typography,
  Tag,
  Space,
  Card,
  theme,
  Empty,
  Divider,
} from 'antd';
import {
  PlusCircleOutlined,
  MinusCircleOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import type { DistrictSettingsDiff } from './diff-utils.js';

const { Text } = Typography;

export interface ConfigurationDiffViewerProps {
  districtDiff?: DistrictSettingsDiff;
  mode?: 'activation' | 'rollback';
}

export const ConfigurationDiffViewer: React.FC<ConfigurationDiffViewerProps> = ({
  districtDiff,
  mode = 'activation',
}) => {
  const { token } = theme.useToken();

  const diff = districtDiff;

  if (!diff || !diff.hasChanges) {
    return (
      <Card
        size="small"
        style={{
          background: token.colorFillQuaternary,
          borderRadius: token.borderRadius,
          textAlign: 'center',
          padding: 16,
        }}
      >
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Text type="secondary">
              {mode === 'rollback'
                ? 'Қайтариладиган версияда фаол созламаларга нисбатан ҳеч қандай ўзгариш мавжуд эмас.'
                : 'Қораламада фаол созламаларга нисбатан ҳеч қандай ўзгариш мавжуд эмас.'}
            </Text>
          }
        />
      </Card>
    );
  }

  return (
    <div
      tabIndex={0}
      role="region"
      aria-label="Созламалар ўзгаришлари фарқи"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        maxHeight: 420,
        overflowY: 'auto',
        overflowX: 'hidden',
        paddingRight: 4,
        outline: 'none',
      }}
    >
      {/* Hokim Recognition Terms diffs */}
      <Card
        size="small"
        title={
          <Text strong style={{ fontSize: 13 }}>
            Ҳокимга оид атамалар (Hokim Recognition Terms)
          </Text>
        }
        style={{
          borderRadius: token.borderRadius,
          border: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Added terms */}
          {districtDiff.hokimTermsDiffs.some((t) => t.type === 'added') && (
            <div>
              <Text type="success" strong style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
                + Қўшилган янги атамалар:
              </Text>
              <Space wrap size={[6, 8]}>
                {districtDiff.hokimTermsDiffs
                  .filter((t) => t.type === 'added')
                  .map((t) => (
                    <Tag
                      key={t.term}
                      color="success"
                      icon={<PlusCircleOutlined />}
                      style={{ padding: '2px 8px' }}
                    >
                      + {t.term}
                    </Tag>
                  ))}
              </Space>
            </div>
          )}

          {/* Removed terms */}
          {districtDiff.hokimTermsDiffs.some((t) => t.type === 'removed') && (
            <div>
              <Text type="danger" strong style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
                - Ўчирилган атамалар:
              </Text>
              <Space wrap size={[6, 8]}>
                {districtDiff.hokimTermsDiffs
                  .filter((t) => t.type === 'removed')
                  .map((t) => (
                    <Tag
                      key={t.term}
                      color="error"
                      icon={<MinusCircleOutlined />}
                      style={{ padding: '2px 8px' }}
                    >
                      <del>- {t.term}</del>
                    </Tag>
                  ))}
              </Space>
            </div>
          )}

          {/* Unchanged terms summary */}
          <Divider style={{ margin: '8px 0' }} />
          <Text type="secondary" style={{ fontSize: 12 }}>
            Ўзгаришсиз сақланган атамалар:{' '}
            {districtDiff.hokimTermsDiffs.filter((t) => t.type === 'unchanged').length} та
          </Text>
        </div>
      </Card>

      {/* District Local Vocabulary diffs */}
      <Card
        size="small"
        title={
          <Text strong style={{ fontSize: 13 }}>
            Қўшимча маҳаллий луғат (District Local Vocabulary)
          </Text>
        }
        style={{
          borderRadius: token.borderRadius,
          border: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Added vocab */}
          {districtDiff.vocabularyDiffs.some((v) => v.type === 'added') && (
            <div>
              <Text type="success" strong style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
                + Қўшилган янги атамалар:
              </Text>
              <Space wrap size={[6, 8]}>
                {districtDiff.vocabularyDiffs
                  .filter((v) => v.type === 'added')
                  .map((v) => (
                    <Tag
                      key={v.term}
                      color="success"
                      icon={<PlusCircleOutlined />}
                      style={{ padding: '2px 8px' }}
                    >
                      <Text strong style={{ color: 'inherit' }}>
                        + {v.term}
                      </Text>{' '}
                      <span style={{ opacity: 0.85 }}>({v.category})</span>
                    </Tag>
                  ))}
              </Space>
            </div>
          )}

          {/* Modified vocab */}
          {districtDiff.vocabularyDiffs.some((v) => v.type === 'modified') && (
            <div>
              <Text type="warning" strong style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
                ~ Таҳрирланган атамалар:
              </Text>
              <Space wrap size={[6, 8]}>
                {districtDiff.vocabularyDiffs
                  .filter((v) => v.type === 'modified')
                  .map((v) => (
                    <Tag
                      key={v.term}
                      color="processing"
                      icon={<SyncOutlined />}
                      style={{ padding: '2px 8px' }}
                    >
                      <Text strong style={{ color: 'inherit' }}>
                        ~ {v.term}
                      </Text>{' '}
                      <span style={{ opacity: 0.85 }}>
                        (
                        {v.oldCategory && v.oldCategory !== v.category
                          ? `${v.oldCategory} ➔ ${v.category}`
                          : 'тавсифи янгиланган'}
                        )
                      </span>
                    </Tag>
                  ))}
              </Space>
            </div>
          )}

          {/* Removed vocab */}
          {districtDiff.vocabularyDiffs.some((v) => v.type === 'removed') && (
            <div>
              <Text type="danger" strong style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
                - Ўчирилган атамалар:
              </Text>
              <Space wrap size={[6, 8]}>
                {districtDiff.vocabularyDiffs
                  .filter((v) => v.type === 'removed')
                  .map((v) => (
                    <Tag
                      key={v.term}
                      color="error"
                      icon={<MinusCircleOutlined />}
                      style={{ padding: '2px 8px' }}
                    >
                      <del style={{ color: 'inherit' }}>- {v.term}</del>{' '}
                      <span style={{ opacity: 0.85 }}>({v.category})</span>
                    </Tag>
                  ))}
              </Space>
            </div>
          )}

          {/* Unchanged vocab summary */}
          <Divider style={{ margin: '8px 0' }} />
          <Text type="secondary" style={{ fontSize: 12 }}>
            Ўзгаришсиз сақланган атамалар:{' '}
            {districtDiff.vocabularyDiffs.filter((v) => v.type === 'unchanged').length} та
          </Text>
        </div>
      </Card>
    </div>
  );
};
