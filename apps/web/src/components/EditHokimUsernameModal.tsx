import React, { useEffect } from 'react';
import { Modal, Form, Input, Button, Alert, Typography } from 'antd';
import { EditOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { themeColors } from '../theme/antd-theme.js';

const { Text } = Typography;

export interface EditHokimUsernameModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (values: { username: string }) => Promise<void>;
  currentUsername: string;
  isLoading: boolean;
  error: Error | null;
}

export const EditHokimUsernameModal: React.FC<EditHokimUsernameModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  currentUsername,
  isLoading,
  error,
}) => {
  const [form] = Form.useForm();

  useEffect(() => {
    if (isOpen) {
      form.setFieldsValue({ username: currentUsername });
    }
  }, [isOpen, currentUsername, form]);

  const handleCancel = () => {
    form.resetFields();
    onClose();
  };

  const handleFinish = async (values: { username: string }) => {
    await onSubmit(values);
    form.resetFields();
  };

  return (
    <Modal
      open={isOpen}
      onCancel={handleCancel}
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <EditOutlined style={{ color: themeColors.colorPrimary }} />
          Ҳоким исмини таҳрирлаш
        </span>
      }
      footer={null}
      destroyOnHidden
    >
      <div style={{ marginTop: 16 }}>
        <Alert
          message="Маълумот"
          description={
            <span>
              Ушбу амал ҳокимнинг тизимда кўринадиган исми / фойдаланувчи номини ўзгартиради. Ҳозирги <Text strong>{currentUsername}</Text> ҳисобининг пароли ва фаол сессиялари сақланиб қолади.
            </span>
          }
          type="info"
          showIcon
          icon={<InfoCircleOutlined />}
          style={{ marginBottom: 16 }}
        />

        {error && (
          <Alert
            message={error.message || 'Исмни ўзгартиришда хатолик юз берди.'}
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}

        <Form
          form={form}
          layout="vertical"
          onFinish={handleFinish}
          initialValues={{ username: currentUsername }}
        >
          <Form.Item
            label="Ҳоким исми (Фойдаланувчи номи / Логин)"
            name="username"
            extra="Ҳарфлар, рақамлар, бўш жой, дефис ва тагчизиқ (3-64 белги)."
            rules={[
              { required: true, message: 'Ҳоким исми / логинини киритинг' },
              { min: 3, message: 'Камида 3 та белги бўлиши керак' },
              { max: 64, message: '64 та белгидан ошмаслиги керак' },
              {
                pattern: /^[\p{L}\p{N}][\p{L}\p{N}_ -]*[\p{L}\p{N}]$/u,
                message: 'Ҳарфлар, рақамлар, бўш жой, дефис ва тагчизиқ ишлатилиши мумкин',
              },
            ]}
          >
            <Input
              placeholder="Масалан: Botir Zoirov ёки Ботир Зоиров"
              autoComplete="off"
              style={{ height: 44 }}
            />
          </Form.Item>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 24 }}>
            <Button onClick={handleCancel} disabled={isLoading} style={{ height: 44 }}>
              Бекор қилиш
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              loading={isLoading}
              style={{ height: 44, paddingInline: 24 }}
            >
              Сақлаш
            </Button>
          </div>
        </Form>
      </div>
    </Modal>
  );
};
