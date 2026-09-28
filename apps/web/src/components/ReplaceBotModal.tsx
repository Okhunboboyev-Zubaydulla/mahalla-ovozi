import { Modal, Space, Form, Input, Button, Alert, Typography } from 'antd';
import { SwapOutlined, LockOutlined } from '@ant-design/icons';
import { themeColors } from '../theme/antd-theme.js';

const { Paragraph, Text } = Typography;

const BOT_TOKEN_REGEX = /^\d{6,16}:[a-zA-Z0-9_-]{20,50}$/;

interface ReplaceBotModalProps {
  isOpen: boolean;
  isConnecting: boolean;
  connectError: Error | null;
  onSubmit: (values: { token: string }) => void | Promise<void>;
  onClose: () => void;
}

export function ReplaceBotModal({
  isOpen,
  isConnecting,
  connectError,
  onSubmit,
  onClose,
}: ReplaceBotModalProps) {
  const [form] = Form.useForm();

  const handleClose = () => {
    if (!isConnecting) {
      form.resetFields();
      onClose();
    }
  };

  const handleFinish = async (values: { token: string }) => {
    await onSubmit(values);
    form.resetFields();
  };

  return (
    <Modal
      title={
        <Space>
          <SwapOutlined style={{ color: themeColors.colorPrimary }} />
          <span>Telegram ботни алмаштириш</span>
        </Space>
      }
      open={isOpen}
      onCancel={handleClose}
      footer={null}
      destroyOnHidden
    >
      <Space direction="vertical" size="middle" style={{ width: '100%', marginTop: '12px' }}>
        <Paragraph type="secondary">
          Янги бот токенини киритинг. Эски бот маълумотлари ўчирилади ва янги бот текширилиб
          фаоллаштирилади.
        </Paragraph>

        {connectError && isOpen && (
          <Alert
            message="Алмаштиришда хатолик"
            description={connectError.message || 'Янги бот токенини текширишда хатолик юз берди.'}
            type="error"
            showIcon
          />
        )}

        <Form form={form} layout="vertical" onFinish={handleFinish} requiredMark={false}>
          <Form.Item
            name="token"
            label={<Text strong>Янги Telegram бот токени</Text>}
            rules={[
              { required: true, message: 'Илтимос, янги Telegram бот токенини киритинг.' },
              {
                pattern: BOT_TOKEN_REGEX,
                transform: (value: string) => value?.trim(),
                message: 'Илтимос, тўғри Telegram бот токенини киритинг (масалан: 123456789:ABCdefGHIjkl...).',
              },
            ]}
          >
            <Input.Password
              placeholder="123456789:AAF..."
              size="large"
              prefix={<LockOutlined style={{ color: themeColors.colorIconPlaceholder }} />}
              disabled={isConnecting}
              style={{ minHeight: '44px' }}
              autoComplete="off"
            />
          </Form.Item>

          <Space style={{ width: '100%', justifyContent: 'flex-end', display: 'flex' }}>
            <Button onClick={handleClose} disabled={isConnecting} size="large" style={{ minHeight: '44px' }}>
              Бекор қилиш
            </Button>
            <Button type="primary" htmlType="submit" loading={isConnecting} size="large" style={{ minHeight: '44px' }}>
              Алмаштиришни тасдиқлаш
            </Button>
          </Space>
        </Form>
      </Space>
    </Modal>
  );
}
