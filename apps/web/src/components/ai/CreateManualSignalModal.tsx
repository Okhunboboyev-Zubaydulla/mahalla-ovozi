import React from 'react';
import { Modal, Form, Input, Select, message } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { QualifyingLane } from '@mahalla-ovozi/api-contracts';
import { districtClient } from '../../district/district-client.js';
import { useCreateManualSignal } from '../../hooks/useSignalMessages.js';

const { TextArea } = Input;

export interface CreateManualSignalModalProps {
  open: boolean;
  onClose: () => void;
  defaultDistrictId?: string | null;
}

const LANE_LABELS: Record<QualifyingLane, string> = {
  WATER: 'Сув таъминоти',
  ELECTRICITY: 'Электр таъминоти',
  GAS: 'Газ таъминоти',
  WASTE: 'Чиқинди',
  HOKIM_RELATED: 'Ҳокимлик / Инфратузилма',
};

export const CreateManualSignalModal: React.FC<CreateManualSignalModalProps> = ({
  open,
  onClose,
  defaultDistrictId,
}) => {
  const [form] = Form.useForm();
  const createMutation = useCreateManualSignal();

  const { data: districtsData, isLoading: isDistrictsLoading } = useQuery({
    queryKey: ['districts', 'list'],
    queryFn: () => districtClient.listDistricts(),
    staleTime: 60_000,
  });

  const handleSubmit = async (values: {
    districtId: string;
    mahallaName: string;
    verbatimText: string;
    lanes: QualifyingLane[];
    changeReason: string;
  }) => {
    try {
      await createMutation.mutateAsync({
        districtId: values.districtId,
        mahallaName: values.mahallaName.trim(),
        verbatimText: values.verbatimText.trim(),
        lanes: values.lanes,
        changeReason: values.changeReason.trim(),
      });
      message.success('Янги сигнал муваффақиятли яратилди ва мавзуга бириктирилди');
      form.resetFields();
      onClose();
    } catch (err: any) {
      message.error(err.message || 'Сигнал яратишда хатолик юз берди');
    }
  };

  return (
    <Modal
      title="Янги сигнал / хабар киритиш"
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={createMutation.isPending}
      okText="Яратиш"
      cancelText="Бекор қилиш"
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          districtId: defaultDistrictId || undefined,
          lanes: ['HOKIM_RELATED'],
        }}
      >
        <Form.Item
          name="districtId"
          label="Туман"
          rules={[{ required: true, message: 'Туманни танланг' }]}
        >
          <Select
            placeholder="Туманни танланг"
            loading={isDistrictsLoading}
            options={districtsData?.districts.map((d) => ({
              label: d.name,
              value: d.id,
            }))}
          />
        </Form.Item>

        <Form.Item
          name="mahallaName"
          label="Маҳалла номи"
          rules={[{ required: true, message: 'Маҳалла номини киритинг' }]}
        >
          <Input placeholder="Масалан: Истиқлол МФЙ" />
        </Form.Item>

        <Form.Item
          name="lanes"
          label="Соҳа(лар)"
          rules={[{ required: true, message: 'Камида битта соҳа танланг' }]}
        >
          <Select
            mode="multiple"
            placeholder="Соҳани танланг"
            options={Object.entries(LANE_LABELS).map(([k, label]) => ({
              label,
              value: k,
            }))}
          />
        </Form.Item>

        <Form.Item
          name="verbatimText"
          label="Хабар матни"
          rules={[{ required: true, message: 'Хабар матнини киритинг' }]}
        >
          <TextArea rows={4} placeholder="Фуқаро ёки манбадан келган асл хабар матни..." />
        </Form.Item>

        <Form.Item
          name="changeReason"
          label="Яратиш сабаби (Аудит учун)"
          rules={[{ required: true, min: 3, message: 'Камида 3 та белги киритинг' }]}
        >
          <TextArea
            rows={2}
            placeholder="Масалан: Тўғридан-тўғри телефон қўнғироғи орқали қабул қилинган мурожаат."
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};
