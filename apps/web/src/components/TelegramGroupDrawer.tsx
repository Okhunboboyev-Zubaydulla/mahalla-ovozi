import { useState, useEffect } from 'react';
import {
  Drawer,
  Form,
  Input,
  Button,
  Space,
  Alert,
  Typography,
  Grid,
  Select,
  message,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { TelegramGroupMapping, GroupTransport } from '@mahalla-ovozi/api-contracts';
import { telegramGroupClient } from '../district/telegram-group-client.js';
import { themeColors } from '../theme/antd-theme.js';

const { Text } = Typography;
const { useBreakpoint } = Grid;

interface TelegramGroupDrawerProps {
  open: boolean;
  onClose: () => void;
  districtId: string;
  onGroupSaved?: () => void;
  initialGroup?: TelegramGroupMapping | null;
}

export function TelegramGroupDrawer({
  open,
  onClose,
  districtId,
  onGroupSaved,
  initialGroup,
}: TelegramGroupDrawerProps) {
  const screens = useBreakpoint();
  const [form] = Form.useForm();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      form.resetFields();
      setSubmitError(null);

      if (initialGroup) {
        form.setFieldsValue({
          mahallaName: initialGroup.mahallaName,
          telegramChatId: initialGroup.telegramChatId,
          transport: initialGroup.transport ?? 'BOT_API',
        });
      } else {
        form.setFieldsValue({
          transport: 'BOT_API',
        });
      }
    }
  }, [open, initialGroup, form]);

  const handleFormSubmit = async (values: {
    mahallaName: string;
    telegramChatId: string;
    transport?: GroupTransport;
  }) => {
    setIsSubmitting(true);
    setSubmitError(null);

    const trimmedMahalla = values.mahallaName.trim();
    const trimmedChatId = values.telegramChatId.trim();
    const transport: GroupTransport = values.transport ?? 'BOT_API';

    try {
      if (initialGroup) {
        await telegramGroupClient.updateGroup(districtId, initialGroup.id, {
          mahallaName: trimmedMahalla,
          telegramChatId: trimmedChatId,
          transport,
        });
      } else {
        await telegramGroupClient.createGroup(districtId, {
          mahallaName: trimmedMahalla,
          telegramChatId: trimmedChatId,
          transport,
        });
      }

      message.success(
        initialGroup
          ? 'Маҳалла Telegram гуруҳи муваффақиятли янгиланди!'
          : 'Маҳалла Telegram гуруҳи муваффақиятли бириктирилди!',
      );
      onGroupSaved?.();
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Гуруҳни бириктиришда хатолик юз берди.';
      setSubmitError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Drawer
      aria-label={
        initialGroup
          ? 'Маҳалла Telegram гуруҳини таҳрирлаш'
          : 'Маҳалла Telegram гуруҳини бириктириш'
      }
      data-testid="telegram-group-drawer"
      title={
        <Space>
          {initialGroup ? (
            <EditOutlined style={{ color: themeColors.colorPrimary }} />
          ) : (
            <PlusOutlined style={{ color: themeColors.colorPrimary }} />
          )}
          <span>
            {initialGroup
              ? 'Маҳалла Telegram гуруҳини таҳрирлаш'
              : 'Маҳалла Telegram гуруҳини бириктириш'}
          </span>
        </Space>
      }
      placement="right"
      width={screens.xs ? '100%' : 540}
      onClose={() => {
        if (!isSubmitting) {
          onClose();
        }
      }}
      open={open}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={handleFormSubmit} requiredMark={false}>
        <Alert
          message="Гуруҳ Chat ID топиш бўйича кўрсатма"
          description="Telegram гуруҳингиздаги исталган хабарни @userinfobot ёки @raw_data_bot га форвард қилинг. Гуруҳ Chat ID рақами одатда -100 билан бошланади (масалан: -1001234567890)."
          type="info"
          showIcon
          icon={<InfoCircleOutlined />}
          style={{ marginBottom: '16px' }}
        />

        {submitError && (
          <Alert
            message="Бириктиришда хатолик"
            description={submitError}
            type="error"
            showIcon
            icon={<ExclamationCircleOutlined />}
            style={{ marginBottom: '16px' }}
          />
        )}

        <Form.Item
          name="mahallaName"
          label={<Text strong>Маҳалла номи</Text>}
          rules={[
            { required: true, message: 'Илтимос, маҳалла номини киритинг.' },
            { max: 100, message: 'Маҳалла номи 100 та белгидан ошмаслиги керак.' },
          ]}
        >
          <Input
            placeholder="Масалан: Навбаҳор"
            size="large"
            style={{ minHeight: '44px' }}
            disabled={isSubmitting}
          />
        </Form.Item>

        <Form.Item
          name="telegramChatId"
          label={<Text strong>Telegram гуруҳ Chat ID</Text>}
          rules={[
            { required: true, message: 'Илтимос, Telegram Chat ID рақамини киритинг.' },
            { max: 50, message: 'Chat ID 50 та белгидан ошмаслиги керак.' },
          ]}
          extra="Бот ушбу гуруҳга олдиндан оддий аъзо сифатида қўшилган бўлиши шарт."
        >
          <Input
            placeholder="Масалан: -1001234567890"
            size="large"
            style={{ minHeight: '44px' }}
            disabled={isSubmitting}
          />
        </Form.Item>

        <Form.Item
          name="transport"
          label={<Text strong>Транспорт тури</Text>}
          initialValue="BOT_API"
        >
          <Select
            disabled={isSubmitting}
            options={[
              { label: 'Bot API', value: 'BOT_API' },
              { label: 'Userbot', value: 'USERBOT' },
            ]}
          />
        </Form.Item>

        <Form.Item style={{ marginTop: '24px' }}>
          <Button
            type="primary"
            htmlType="submit"
            loading={isSubmitting}
            size="large"
            style={{ minHeight: '44px', width: '100%' }}
          >
            {initialGroup ? 'Сақлаш' : 'Текшириш ва бириктириш'}
          </Button>
        </Form.Item>
      </Form>
    </Drawer>
  );
}
