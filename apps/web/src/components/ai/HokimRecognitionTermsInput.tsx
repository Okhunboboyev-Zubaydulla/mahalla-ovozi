import React, { useState } from 'react';
import { Space, Input, Button, Tag, Typography, theme } from 'antd';
import { PlusOutlined } from '@ant-design/icons';

const { Text } = Typography;

interface HokimRecognitionTermsInputProps {
  value?: string[];
  onChange?: (value: string[]) => void;
  disabled?: boolean;
}

export const HokimRecognitionTermsInput: React.FC<
  HokimRecognitionTermsInputProps
> = ({ value = [], onChange, disabled = false }) => {
  const { token } = theme.useToken();
  const [newTerm, setNewTerm] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const safeValue = value ?? [];

  const handleAdd = () => {
    const trimmed = newTerm.trim().replace(/\s+/g, ' ');

    if (!trimmed) {
      setInputError('Ҳоким атамасини киритинг.');
      return;
    }
    if (trimmed.length < 2) {
      setInputError('Атама камида 2 та белгидан иборат бўлиши керак.');
      return;
    }
    if (trimmed.length > 100) {
      setInputError('Атама 100 та белгидан ошмаслиги керак.');
      return;
    }
    if (safeValue.length >= 50) {
      setInputError('Ҳокимга оид атамалар сони 50 тадан ошмаслиги керак.');
      return;
    }

    const normalizedNew = trimmed
      .normalize('NFC')
      .toLowerCase();

    const exists = safeValue.some(
      (term) =>
        term.trim().normalize('NFC').replace(/\s+/g, ' ').toLowerCase() ===
        normalizedNew,
    );

    if (exists) {
      setInputError(`"${trimmed}" атамаси рўйхатда аллақачон мавжуд.`);
      return;
    }

    setInputError(null);
    const updated = [...safeValue, trimmed];
    onChange?.(updated);
    setNewTerm('');
  };

  const handleRemove = (indexToRemove: number) => {
    const updated = safeValue.filter((_, idx) => idx !== indexToRemove);
    onChange?.(updated);
  };

  return (
    <div
      id="draft-hokimRecognitionTerms"
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
                id="hokim-new-term"
                placeholder="Янги атама (масалан: Ҳоким ёрдамчиси)"
                value={newTerm}
                onChange={(e) => {
                  setNewTerm(e.target.value);
                  if (inputError) setInputError(null);
                }}
                onPressEnter={handleAdd}
                style={{ width: 280 }}
                maxLength={100}
              />
              <Button
                id="hokim-add-button"
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

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          minHeight: 40,
          padding: 8,
          background: token.colorBgContainer,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadius,
        }}
      >
        {safeValue.length === 0 ? (
          <Text type="secondary" style={{ fontStyle: 'italic', padding: '4px 8px' }}>
            Атамалар киритилмаган. Камида 1 та атама киритилиши шарт.
          </Text>
        ) : (
          safeValue.map((term, idx) => (
            <Tag
              key={term}
              closable={!disabled}
              onClose={(e) => {
                e.preventDefault();
                handleRemove(idx);
              }}
              closeIcon={
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Ўчириш: ${term}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleRemove(idx);
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  ×
                </span>
              }
              color="cyan"
              style={{
                fontSize: 13,
                padding: '4px 10px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              {term}
            </Tag>
          ))
        )}
      </div>
    </div>
  );
};
