import React, { useState } from 'react';
import {
  Space,
  Input,
  Select,
  Button,
  Table,
  Tag,
  Typography,
  theme,
} from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import {
  type DistrictLocalVocabularyItem,
  DEFAULT_DISTRICT_VOCABULARY_CATEGORIES,
} from '@mahalla-ovozi/api-contracts';

const { Text } = Typography;

const CATEGORY_COLORS: Record<string, string> = {
  'Маҳалла номлари': 'geekblue',
  'Мўлжал ва жойлар': 'purple',
  'Маҳаллий атамалар': 'blue',
  'Сув ҳавзалари ва каналлар': 'cyan',
  'Маҳаллий муассасалар': 'orange',
  'Бошқа': 'default',
};

interface DistrictLocalVocabularyInputProps {
  value?: DistrictLocalVocabularyItem[];
  onChange?: (value: DistrictLocalVocabularyItem[]) => void;
  disabled?: boolean;
}

export const DistrictLocalVocabularyInput: React.FC<
  DistrictLocalVocabularyInputProps
> = ({ value = [], onChange, disabled = false }) => {
  const { token } = theme.useToken();
  const [newTerm, setNewTerm] = useState('');
  const [newCategory, setNewCategory] = useState<string>(
    DEFAULT_DISTRICT_VOCABULARY_CATEGORIES[0],
  );
  const [newDescription, setNewDescription] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const safeValue = value ?? [];

  const handleAdd = () => {
    const trimmedTerm = newTerm.trim().replace(/\s+/g, ' ');
    const trimmedCategory = newCategory.trim().replace(/\s+/g, ' ');
    const trimmedDesc = newDescription.trim().replace(/\s+/g, ' ');

    if (!trimmedTerm) {
      setInputError('Атама номини киритинг.');
      return;
    }
    if (trimmedTerm.length > 100) {
      setInputError('Атама 100 та белгидан ошмаслиги керак.');
      return;
    }
    if (trimmedDesc.length > 500) {
      setInputError('Тавсиф 500 та белгидан ошмаслиги керак.');
      return;
    }
    if (!trimmedCategory) {
      setInputError('Тоифани танланг ёки киритинг.');
      return;
    }
    if (safeValue.length >= 100) {
      setInputError('Маҳаллий луғат атамалари сони 100 тадан ошмаслиги керак.');
      return;
    }

    const normalizedNew = trimmedTerm
      .normalize('NFC')
      .toLowerCase();

    const exists = safeValue.some(
      (item) =>
        item.term.trim().normalize('NFC').replace(/\s+/g, ' ').toLowerCase() ===
        normalizedNew,
    );

    if (exists) {
      setInputError(`"${trimmedTerm}" атамаси рўйхатда аллақачон мавжуд.`);
      return;
    }

    setInputError(null);
    const updated: DistrictLocalVocabularyItem[] = [
      ...safeValue,
      {
        term: trimmedTerm,
        category: trimmedCategory,
        ...(trimmedDesc ? { description: trimmedDesc } : {}),
      },
    ];

    onChange?.(updated);
    setNewTerm('');
    setNewDescription('');
  };

  const handleRemove = (termToRemove: string) => {
    const updated = safeValue.filter((item) => item.term !== termToRemove);
    onChange?.(updated);
  };

  const columns = [
    {
      title: 'Атама',
      dataIndex: 'term',
      key: 'term',
      width: '30%',
      render: (text: string) => <Text strong>{text}</Text>,
    },
    {
      title: 'Тоифа',
      dataIndex: 'category',
      key: 'category',
      width: '25%',
      render: (category: string) => (
        <Tag color={CATEGORY_COLORS[category] || 'default'}>{category}</Tag>
      ),
    },
    {
      title: 'Тавсиф',
      dataIndex: 'description',
      key: 'description',
      width: '35%',
      render: (desc?: string) => (
        <Text type="secondary">{desc || '—'}</Text>
      ),
    },
    {
      title: 'Амал',
      key: 'action',
      width: '10%',
      render: (_: unknown, record: DistrictLocalVocabularyItem) => (
        <Button
          type="text"
          danger
          size="small"
          icon={<DeleteOutlined />}
          disabled={disabled}
          onClick={() => handleRemove(record.term)}
          aria-label={`Ўчириш: ${record.term}`}
        />
      ),
    },
  ];

  return (
    <div
      id="draft-localVocabularyAdditions"
      tabIndex={-1}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        outline: 'none',
      }}
    >
      {!disabled && (
        <div
          style={{
            background: token.colorFillAlter,
            padding: 12,
            borderRadius: token.borderRadiusLG,
            border: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            <Space wrap style={{ width: '100%' }}>
              <Input
                id="district-vocab-new-term"
                placeholder="Янги атама (масалан: Гулистон МФЙ)"
                value={newTerm}
                onChange={(e) => {
                  setNewTerm(e.target.value);
                  if (inputError) setInputError(null);
                }}
                onPressEnter={handleAdd}
                style={{ width: 220 }}
                maxLength={100}
              />
              <Select
                id="district-vocab-new-category"
                value={newCategory}
                onChange={setNewCategory}
                style={{ width: 200 }}
                options={DEFAULT_DISTRICT_VOCABULARY_CATEGORIES.map((cat) => ({
                  label: cat,
                  value: cat,
                }))}
              />
              <Input
                id="district-vocab-new-description"
                placeholder="Қисқача тавсиф (ихтиёрий)"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                onPressEnter={handleAdd}
                style={{ width: 240 }}
                maxLength={500}
              />
              <Button
                id="district-vocab-add-button"
                type="dashed"
                icon={<PlusOutlined />}
                onClick={handleAdd}
              >
                Қўшиш
              </Button>
            </Space>
            {inputError && (
              <Text type="danger" style={{ fontSize: 13 }}>
                {inputError}
              </Text>
            )}
          </Space>
        </div>
      )}

      <Table
        rowKey="term"
        dataSource={safeValue}
        columns={columns}
        pagination={{ pageSize: 6, size: 'small' }}
        size="small"
        bordered
        locale={{
          emptyText: 'Маҳаллий қўшимча луғат киритилмаган (ихтиёрий).',
        }}
      />
    </div>
  );
};
