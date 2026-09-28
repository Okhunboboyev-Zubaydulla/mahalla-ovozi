import React from 'react';
import { Modal, Button, Alert, Typography } from 'antd';
import { KeyOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { themeColors } from '../theme/antd-theme.js';

const { Text, Paragraph } = Typography;

export interface ResetHokimModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  username: string;
  isLoading: boolean;
  error: Error | null;
}

export const ResetHokimModal: React.FC<ResetHokimModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  username,
  isLoading,
  error,
}) => {
  return (
    <Modal
      open={isOpen}
      onCancel={onClose}
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <KeyOutlined style={{ color: themeColors.colorWarning }} />
          Ҳоким аккаунти паролини янгилаш
        </span>
      }
      footer={[
        <Button key="cancel" onClick={onClose} disabled={isLoading} style={{ height: 44 }}>
          Бекор қилиш
        </Button>,
        <Button
          key="confirm"
          type="primary"
          danger
          onClick={onConfirm}
          loading={isLoading}
          style={{ height: 44, paddingInline: 24 }}
        >
          Паролни янгилаш
        </Button>,
      ]}
    >
      <div style={{ marginTop: 16 }}>
        {error && (
          <Alert
            message={error.message || 'Паролни янгилашда хатолик юз берди.'}
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}

        <Alert
          message="Диққат! Парол янгиланганда барча фаол сессиялар тўхтатилади"
          description="Ушбу амал янги вақтинчалик парол яратади ва ҳокимнинг барча очиқ сессияларини дарҳол бекор қилади. Янги паролни ҳокимга етказишингиз керак бўлади."
          type="warning"
          showIcon
          icon={<ExclamationCircleOutlined />}
          style={{ marginBottom: 16 }}
        />

        <Paragraph>
          Сиз ҳақиқатан ҳам <Text strong>@{username}</Text> аккаунти учун янги вақтинчалик парол яратмоқчимисиз?
        </Paragraph>
      </div>
    </Modal>
  );
};
