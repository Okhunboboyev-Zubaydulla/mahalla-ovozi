import React from 'react';
import { Modal, Button, Alert, Typography } from 'antd';
import { StopOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { themeColors } from '../theme/antd-theme.js';

const { Text, Paragraph } = Typography;

export interface DisableHokimModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  username: string;
  isLoading: boolean;
  error: Error | null;
}

export const DisableHokimModal: React.FC<DisableHokimModalProps> = ({
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
          <StopOutlined style={{ color: themeColors.colorError }} />
          Ҳоким аккаунтини фаолсизлантириш
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
          Фаолсизлантириш
        </Button>,
      ]}
    >
      <div style={{ marginTop: 16 }}>
        {error && (
          <Alert
            message={error.message || 'Аккаунтни фаолсизлантиришда хатолик юз берди.'}
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}

        <Alert
          message="Диққат! Аккаунт фаолсизлантирилганда кириш ҳуқуқи тўхтатилади"
          description="Ушбу амал ҳоким аккаунти ҳолатини «Фаолсизлантирилган»га ўзгартиради ва барча очиқ сессияларини дарҳол бекор қилади. Ушбу аккаунт орқали тизимга кириб бўлмайди."
          type="error"
          showIcon
          icon={<ExclamationCircleOutlined />}
          style={{ marginBottom: 16 }}
        />

        <Paragraph>
          Сиз ҳақиқатан ҳам <Text strong>@{username}</Text> аккаунтини фаолсизлантирмоқчимисиз?
        </Paragraph>
      </div>
    </Modal>
  );
};
