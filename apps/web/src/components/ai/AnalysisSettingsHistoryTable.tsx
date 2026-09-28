import React from 'react';
import { Table, Tag, Button, Tooltip, Typography, Space, theme } from 'antd';
import {
  CheckCircleOutlined,
  HistoryOutlined,
  RollbackOutlined,
} from '@ant-design/icons';
import type {
  DistrictAnalysisSettingsDto,
} from '@mahalla-ovozi/api-contracts';
import { formatTashkentDate } from '../../lib/formatters.js';

const { Text } = Typography;

export interface AnalysisSettingsHistoryTableProps {
  items: Array<DistrictAnalysisSettingsDto>;
  loading?: boolean;
  onRollbackClick: (
    version: DistrictAnalysisSettingsDto,
  ) => void;
}

export const AnalysisSettingsHistoryTable: React.FC<
  AnalysisSettingsHistoryTableProps
> = ({ items, loading = false, onRollbackClick }) => {
  const { token } = theme.useToken();

  const columns = [
    {
      title: 'Версия',
      dataIndex: 'version',
      key: 'version',
      width: 140,
      render: (_: number, record: DistrictAnalysisSettingsDto) => (
        <Space direction="vertical" size={2}>
          <Tag color="blue" style={{ fontWeight: 600 }}>
            V{record.version}
          </Tag>
          <Text
            type="secondary"
            style={{
              fontSize: 11,
              fontFamily: token.fontFamilyCode,
              wordBreak: 'break-all',
            }}
          >
            {record.id}
          </Text>
        </Space>
      ),
    },
    {
      title: 'Ҳолати',
      dataIndex: 'isActive',
      key: 'isActive',
      width: 120,
      render: (isActive: boolean) =>
        isActive ? (
          <Tag
            color="success"
            icon={<CheckCircleOutlined />}
            style={{ fontWeight: 600, padding: '2px 8px' }}
          >
            Фаол
          </Tag>
        ) : (
          <Tag
            color="default"
            icon={<HistoryOutlined />}
            style={{ padding: '2px 8px' }}
          >
            Тарихий
          </Tag>
        ),
    },
    {
      title: 'Фаоллаштирилган вақти',
      dataIndex: 'activatedAt',
      key: 'activatedAt',
      width: 180,
      render: (activatedAt: string | null) => (
        <Text style={{ fontSize: 13 }}>
          {activatedAt ? formatTashkentDate(activatedAt) : '—'}
        </Text>
      ),
    },
    {
      title: 'Масъул',
      dataIndex: 'activatedBy',
      key: 'activatedBy',
      width: 140,
      render: (activatedBy: string | null) => (
        <Text type={activatedBy ? undefined : 'secondary'} style={{ fontSize: 12 }}>
          {activatedBy || 'Тизим'}
        </Text>
      ),
    },
    {
      title: 'Ўзгартириш сабаби',
      dataIndex: 'changeReason',
      key: 'changeReason',
      ellipsis: true,
      render: (changeReason: string | null) => (
        <Tooltip title={changeReason || 'Сабаб кўрсатилмаган'} placement="topLeft">
          <Text style={{ fontSize: 13 }}>
            {changeReason || <Text type="secondary">—</Text>}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: 'Созламалар хулосаси',
      key: 'summary',
      width: 220,
      render: (_: unknown, record: DistrictAnalysisSettingsDto) => (
        <Space direction="vertical" size={2}>
          <Text style={{ fontSize: 12 }}>
            Ҳоким атамалари: {record.hokimRecognitionTerms?.length || 0} та
          </Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            Маҳаллий луғат: {record.localVocabularyAdditions?.length || 0} та
          </Text>
        </Space>
      ),
    },
    {
      title: 'Амаллар',
      key: 'actions',
      width: 130,
      render: (_: unknown, record: DistrictAnalysisSettingsDto) => {
        if (record.isActive) {
          return (
            <Tooltip title="Жорий фаол версия">
              <span>
                <Button
                  id={`btn-rollback-${record.id}`}
                  size="small"
                  disabled
                  icon={<RollbackOutlined />}
                  aria-label={`V${record.version} версиясини қайтариш`}
                >
                  Қайтариш
                </Button>
              </span>
            </Tooltip>
          );
        }

        return (
          <Button
            id={`btn-rollback-${record.id}`}
            size="small"
            type="primary"
            ghost
            icon={<RollbackOutlined />}
            aria-label={`V${record.version} версиясини қайтариш`}
            onClick={() => onRollbackClick(record)}
          >
            Қайтариш
          </Button>
        );
      },
    },
  ];

  return (
    <Table
      rowKey="id"
      columns={columns}
      dataSource={items}
      loading={loading}
      pagination={false}
      size="middle"
      scroll={{ x: 900 }}
      locale={{
        emptyText: 'Тарихий версиялар мавжуд эмас.',
      }}
    />
  );
};
