import { Modal, Space, Button, Alert, Typography } from 'antd';
import { ExclamationCircleOutlined } from '@ant-design/icons';
import { themeColors } from '../theme/antd-theme.js';

const { Paragraph, Text } = Typography;

interface DisconnectBotModalProps {
  isOpen: boolean;
  isDisconnecting: boolean;
  disconnectError: Error | null;
  districtName: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

export function DisconnectBotModal({
  isOpen,
  isDisconnecting,
  disconnectError,
  districtName,
  onConfirm,
  onClose,
}: DisconnectBotModalProps) {
  const handleClose = () => {
    if (!isDisconnecting) {
      onClose();
    }
  };

  return (
    <Modal
      title={
        <Space>
          <ExclamationCircleOutlined style={{ color: themeColors.colorError }} />
          <span>Telegram ботни узишни тасдиқланг</span>
        </Space>
      }
      open={isOpen}
      onCancel={handleClose}
      footer={[
        <Button
          key="cancel"
          onClick={handleClose}
          disabled={isDisconnecting}
          size="large"
          style={{ minHeight: '44px' }}
        >
          Бекор қилиш
        </Button>,
        <Button
          key="disconnect"
          danger
          type="primary"
          loading={isDisconnecting}
          onClick={onConfirm}
          size="large"
          style={{ minHeight: '44px' }}
        >
          Ҳа, ботни узиш
        </Button>,
      ]}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%', marginTop: '12px' }}>
        <Paragraph>
          Ҳақиқатан ҳам <Text strong>{districtName}</Text> туманига бириктирилган Telegram
          ботни узмоқчимисиз?
        </Paragraph>
        <Alert
          message="Огоҳлантириш"
          description="Бот узилгандан сўнг, ушбу туманда Telegram хабарларини йиғиш тўхтатилади ва туманнинг тайёргарлик ҳолати тўлиқ эмас деб белгиланади."
          type="warning"
          showIcon
        />
        {disconnectError && (
          <Alert
            message="Ботни узишда хатолик"
            description={disconnectError.message || 'Ботни узишда кутилмаган хатолик юз берди.'}
            type="error"
            showIcon
          />
        )}
      </Space>
    </Modal>
  );
}
