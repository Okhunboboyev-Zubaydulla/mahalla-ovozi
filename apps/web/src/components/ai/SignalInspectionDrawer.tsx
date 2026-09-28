import React, { useState } from 'react';
import {
  Drawer,
  Typography,
  Tag,
  Space,
  Button,
  Descriptions,
  Spin,
  Alert,
  Card,
  Modal,
  Form,
  Input,
  Select,
  message,
  Divider,
  theme,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  SwapOutlined,
  EditOutlined,
  DeleteOutlined,
  PlusCircleOutlined,
  RobotOutlined,
  CopyOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import type { QualifyingLane } from '@mahalla-ovozi/api-contracts';
import {
  useSignalDetail,
  usePromoteSignal,
  useReclassifyEvidence,
  useUpdateEvidenceText,
  useDeleteEvidence,
} from '../../hooks/useSignalMessages.js';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

export interface SignalInspectionDrawerProps {
  signalId: string | null;
  open: boolean;
  onClose: () => void;
}

const LANE_LABELS: Record<QualifyingLane, { label: string; color: string }> = {
  WATER: { label: 'Сув таъминоти', color: 'blue' },
  ELECTRICITY: { label: 'Электр таъминоти', color: 'gold' },
  GAS: { label: 'Газ таъминоти', color: 'volcano' },
  WASTE: { label: 'Чиқинди', color: 'green' },
  HOKIM_RELATED: { label: 'Ҳокимлик / Инфратузилма', color: 'purple' },
};

const EXCLUSION_LABELS: Record<string, string> = {
  PLANNED_ANNOUNCEMENT: 'Режали эълон',
  ADVERTISEMENT_OR_SPAM: 'Реклама / Спам',
  SPECULATION_OR_RUMOR: 'Миш-миш / Тахмин',
  NEUTRAL_OR_PRAISE: 'Миннатдорчилик / Салом-алик',
  GENERAL_CHATTER: 'Умумий суҳбат',
  UNRESOLVED_AMBIGUOUS_FRAGMENT: 'Ноаниқ қисқа матн',
  AI_PROCESSING_ERROR: 'АИ таҳлил хатолиги',
};

export const SignalInspectionDrawer: React.FC<SignalInspectionDrawerProps> = ({
  signalId,
  open,
  onClose,
}) => {
  const { token } = theme.useToken();
  const { data: detailData, isLoading, isError, error } = useSignalDetail(signalId);

  const promoteMutation = usePromoteSignal();
  const reclassifyMutation = useReclassifyEvidence();
  const updateTextMutation = useUpdateEvidenceText();
  const deleteMutation = useDeleteEvidence();

  // Modals state
  const [promoteModalOpen, setPromoteModalOpen] = useState(false);
  const [reclassifyModalOpen, setReclassifyModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  const [promoteForm] = Form.useForm();
  const [reclassifyForm] = Form.useForm();
  const [editForm] = Form.useForm();
  const [deleteForm] = Form.useForm();

  const signal = detailData?.signal;

  const handleCopyText = (text: string) => {
    navigator.clipboard.writeText(text);
    message.success('Матн нусхаланди');
  };

  const handlePromote = async (values: { lanes: QualifyingLane[]; changeReason: string }) => {
    if (!signal?.intakeId) return;
    try {
      await promoteMutation.mutateAsync({
        id: signal.intakeId,
        payload: {
          lanes: values.lanes,
          changeReason: values.changeReason,
        },
      });
      message.success('Хабар далил сифатида муваффақиятли қабул қилинди');
      setPromoteModalOpen(false);
      promoteForm.resetFields();
    } catch (err: any) {
      message.error(err.message || 'Хабарни қабул қилишда хатолик юз берди');
    }
  };

  const handleReclassify = async (values: { lanes: QualifyingLane[]; changeReason: string }) => {
    if (!signal?.evidenceId) return;
    try {
      await reclassifyMutation.mutateAsync({
        id: signal.evidenceId,
        payload: {
          lanes: values.lanes,
          changeReason: values.changeReason,
        },
      });
      message.success('Далил соҳаси муваффақиятли қайта таснифланди');
      setReclassifyModalOpen(false);
      reclassifyForm.resetFields();
    } catch (err: any) {
      message.error(err.message || 'Қайта таснифлашда хатолик юз берди');
    }
  };

  const handleUpdateText = async (values: { verbatimText: string; changeReason: string }) => {
    if (!signal?.evidenceId) return;
    try {
      await updateTextMutation.mutateAsync({
        id: signal.evidenceId,
        payload: {
          verbatimText: values.verbatimText,
          changeReason: values.changeReason,
        },
      });
      message.success('Далил матни янгиланди ва мавзу қайта ҳисобланди');
      setEditModalOpen(false);
      editForm.resetFields();
    } catch (err: any) {
      message.error(err.message || 'Матнни янгилашда хатолик юз берди');
    }
  };

  const handleDelete = async (values: { changeReason: string }) => {
    if (!signal?.evidenceId) return;
    try {
      await deleteMutation.mutateAsync({
        id: signal.evidenceId,
        payload: {
          changeReason: values.changeReason,
        },
      });
      message.success('Далил ўчирилди');
      setDeleteModalOpen(false);
      deleteForm.resetFields();
      onClose();
    } catch (err: any) {
      message.error(err.message || 'Далилни ўчиришда хатолик юз берди');
    }
  };

  return (
    <>
      <Drawer
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <RobotOutlined style={{ color: token.colorPrimary, fontSize: 20 }} />
            <span>Сигнал ва AI таҳлил тафсилотлари</span>
          </div>
        }
        placement="right"
        width={680}
        onClose={onClose}
        open={open}
        destroyOnHidden
      >
        {isLoading && (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Spin size="large" tip="Маълумотлар юкланмоқда..." />
          </div>
        )}

        {isError && (
          <Alert
            type="error"
            message="Юклашда хатолик"
            description={error instanceof Error ? error.message : 'Маълумотларни олишнинг имкони бўлмади.'}
            showIcon
          />
        )}

        {signal && (
          <div>
            {/* Status Header */}
            <div style={{ marginBottom: 16 }}>
              {signal.status === 'PENDING' ? (
                <Alert
                  type="info"
                  showIcon
                  icon={<SyncOutlined spin />}
                  message={
                    <span style={{ fontWeight: 600 }}>
                      АИ қарори: Жараёнда (PENDING / DEBOUNCING)
                    </span>
                  }
                  description="Ушбу хабар навбатда ва таҳлил жараёнида бўлиб, тез орада АИ томонидан кўриб чиқилади."
                />
              ) : signal.status === 'ACCEPTED' || signal.isRelevant ? (
                <Alert
                  type="success"
                  showIcon
                  icon={<CheckCircleOutlined />}
                  message={
                    <span style={{ fontWeight: 600 }}>
                      АИ қарори: Қабул қилинди (ACCEPTED EVIDENCE)
                    </span>
                  }
                  description="Ушбу хабар аҳоли мурожаати сифатида қабул қилиниб, мавзуга бириктирилган."
                />
              ) : (
                <Alert
                  type="warning"
                  showIcon
                  icon={<CloseCircleOutlined />}
                  message={
                    <span style={{ fontWeight: 600 }}>
                      АИ қарори: Рад этилди (EXCLUDED / IGNORED)
                    </span>
                  }
                  description={`Сабаби: ${EXCLUSION_LABELS[signal.exclusionReason || ''] || signal.exclusionReason || 'Номаълум'}`}
                />
              )}
            </div>

            {/* Verbatim Message Card */}
            <Card
              size="small"
              title={<Text strong>Тўлиқ хабар матни (Verbatim Text)</Text>}
              extra={
                <Button
                  type="text"
                  icon={<CopyOutlined />}
                  size="small"
                  onClick={() => handleCopyText(signal.verbatimText)}
                >
                  Нусха олиш
                </Button>
              }
              style={{
                background: token.colorFillAlter,
                borderRadius: token.borderRadiusLG,
                marginBottom: 16,
              }}
            >
              <Paragraph
                style={{
                  fontSize: 15,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  margin: 0,
                  fontFamily: 'inherit',
                }}
              >
                {signal.verbatimText}
              </Paragraph>
            </Card>

            {/* AI Reasoning Card */}
            <Card
              size="small"
              title={
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <RobotOutlined style={{ color: token.colorPrimary }} />
                  <Text strong>AI Таҳлил ва Қарор Асоси (Reasoning)</Text>
                </span>
              }
              style={{
                borderRadius: token.borderRadiusLG,
                background: token.colorInfoBg,
                border: `1px solid ${token.colorInfoBorder}`,
                marginBottom: 16,
              }}
            >
              <Paragraph style={{ margin: 0, fontSize: 14, color: token.colorTextHeading }}>
                {signal.reasoning ||
                  (signal.isRelevant || signal.status === 'ACCEPTED'
                    ? 'Ушбу хабар фуқаронинг кетма-кет ёзган хабарлари билан биргаликда умумий мурожаат сифатида баҳоланган ва қабул қилинган.'
                    : '(АИ томонидан асос кўрсатилмаган)')}
              </Paragraph>
            </Card>

            {/* Metadata Descriptions */}
            <Descriptions
              bordered
              size="small"
              column={1}
              style={{ marginBottom: 16 }}
              items={[
                {
                  key: 'location',
                  label: 'Ҳудуд / Маҳалла',
                  children: (
                    <>
                      <Text strong>{signal.districtName || signal.districtId}</Text> / {signal.mahallaName}
                    </>
                  ),
                },
                {
                  key: 'timestamp',
                  label: 'Юборилган вақти',
                  children: new Date(signal.originalTimestamp).toLocaleString('uz-UZ', {
                    timeZone: 'Asia/Tashkent',
                  }),
                },
                {
                  key: 'lanes',
                  label: 'Бириктирилган соҳалар',
                  children: (
                    <Space wrap size={[0, 6]}>
                      {signal.relevantLanes.length > 0 ? (
                        signal.relevantLanes.map((lane) => {
                          const meta = LANE_LABELS[lane] || { label: lane, color: 'default' };
                          return (
                            <Tag key={lane} color={meta.color}>
                              {meta.label}
                            </Tag>
                          );
                        })
                      ) : (
                        <Text type="secondary">—</Text>
                      )}
                    </Space>
                  ),
                },
                ...(signal.topicSummary
                  ? [
                      {
                        key: 'topic',
                        label: 'Бириктирилган Мавзу',
                        children: <Text>{signal.topicSummary}</Text>,
                      },
                    ]
                  : []),
                ...(detailData?.durationMs !== null && detailData?.durationMs !== undefined
                  ? [
                      {
                        key: 'metrics',
                        label: 'Ижро кўрсаткичлари',
                        children: (
                          <Space size="middle">
                            <Text type="secondary">Вақт: {detailData.durationMs} мс</Text>
                            {typeof detailData.inputTokens === 'number' && (
                              <Text type="secondary">
                                Токенлар: {detailData.inputTokens} kiruvchi / {detailData.outputTokens} chiquvchi
                              </Text>
                            )}
                          </Space>
                        ),
                      },
                    ]
                  : []),
              ]}
            />

            <Divider style={{ margin: '16px 0' }} />

            {/* Administrative Action Controls */}
            <div>
              <Title level={5}>Бошқарув ва CRUD амаллари</Title>
              <Space wrap size="middle">
                {!signal.isRelevant ? (
                  <Button
                    type="primary"
                    icon={<PlusCircleOutlined />}
                    onClick={() => {
                      promoteForm.setFieldsValue({
                        lanes: ['HOKIM_RELATED'],
                        changeReason: '',
                      });
                      setPromoteModalOpen(true);
                    }}
                  >
                    Далил сифатида қабул қилиш (Promote)
                  </Button>
                ) : (
                  <>
                    <Button
                      icon={<SwapOutlined />}
                      onClick={() => {
                        reclassifyForm.setFieldsValue({
                          lanes: signal.relevantLanes.length > 0 ? signal.relevantLanes : ['HOKIM_RELATED'],
                          changeReason: '',
                        });
                        setReclassifyModalOpen(true);
                      }}
                    >
                      Соҳани ўзгартириш (Reclassify)
                    </Button>

                    <Button
                      icon={<EditOutlined />}
                      onClick={() => {
                        editForm.setFieldsValue({
                          verbatimText: signal.verbatimText,
                          changeReason: '',
                        });
                        setEditModalOpen(true);
                      }}
                    >
                      Матнни таҳрирлаш
                    </Button>

                    <Button
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => {
                        deleteForm.setFieldsValue({ changeReason: '' });
                        setDeleteModalOpen(true);
                      }}
                    >
                      Далилни ўчириш
                    </Button>
                  </>
                )}
              </Space>
            </div>
          </div>
        )}
      </Drawer>

      {/* 1. Promote Modal */}
      <Modal
        title="Хабарни далил сифатида қабул қилиш"
        open={promoteModalOpen}
        onCancel={() => setPromoteModalOpen(false)}
        onOk={() => promoteForm.submit()}
        confirmLoading={promoteMutation.isPending}
        okText="Қабул қилиш"
        cancelText="Бекор қилиш"
        destroyOnHidden
      >
        <Form form={promoteForm} layout="vertical" onFinish={handlePromote}>
          <Form.Item
            name="lanes"
            label="Бириктириладиган соҳа(лар)"
            rules={[{ required: true, message: 'Камида битта соҳа танланг' }]}
          >
            <Select
              mode="multiple"
              placeholder="Соҳани танланг"
              options={Object.entries(LANE_LABELS).map(([k, v]) => ({
                label: v.label,
                value: k,
              }))}
            />
          </Form.Item>

          <Form.Item
            name="changeReason"
            label="Қабул қилиш сабаби (Аудит учун)"
            rules={[{ required: true, min: 3, message: 'Камида 3 та белги киритинг' }]}
          >
            <TextArea
              rows={3}
              placeholder="Масалан: АИ хабарни нотўғри тушунган, аслида сув муаммоси билдирилган."
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 2. Reclassify Modal */}
      <Modal
        title="Далил соҳасини қайта таснифлаш"
        open={reclassifyModalOpen}
        onCancel={() => setReclassifyModalOpen(false)}
        onOk={() => reclassifyForm.submit()}
        confirmLoading={reclassifyMutation.isPending}
        okText="Ўзгартириш"
        cancelText="Бекор қилиш"
        destroyOnHidden
      >
        <Form form={reclassifyForm} layout="vertical" onFinish={handleReclassify}>
          <Form.Item
            name="lanes"
            label="Янги соҳа(лар)"
            rules={[{ required: true, message: 'Камида битта соҳа танланг' }]}
          >
            <Select
              mode="multiple"
              placeholder="Соҳани танланг"
              options={Object.entries(LANE_LABELS).map(([k, v]) => ({
                label: v.label,
                value: k,
              }))}
            />
          </Form.Item>

          <Form.Item
            name="changeReason"
            label="Ўзгартириш сабаби (Аудит учун)"
            rules={[{ required: true, min: 3, message: 'Камида 3 та белги киритинг' }]}
          >
            <TextArea
              rows={3}
              placeholder="Масалан: Хабар электр эмас, газ соҳасига тегишли эканлиги аниқланди."
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 3. Edit Text Modal */}
      <Modal
        title="Далил матнини таҳрирлаш"
        open={editModalOpen}
        onCancel={() => setEditModalOpen(false)}
        onOk={() => editForm.submit()}
        confirmLoading={updateTextMutation.isPending}
        okText="Сақлаш"
        cancelText="Бекор қилиш"
        destroyOnHidden
      >
        <Form form={editForm} layout="vertical" onFinish={handleUpdateText}>
          <Form.Item
            name="verbatimText"
            label="Хабар матни"
            rules={[{ required: true, message: 'Матн бўш бўлмаслиги керак' }]}
          >
            <TextArea rows={4} />
          </Form.Item>

          <Form.Item
            name="changeReason"
            label="Таҳрирлаш сабаби (Аудит учун)"
            rules={[{ required: true, min: 3, message: 'Камида 3 та белги киритинг' }]}
          >
            <TextArea
              rows={3}
              placeholder="Масалан: Матндаги техник хатолик тузатилди."
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 4. Delete Modal */}
      <Modal
        title="Далилни ўчиришни тасдиқлаш"
        open={deleteModalOpen}
        onCancel={() => setDeleteModalOpen(false)}
        onOk={() => deleteForm.submit()}
        confirmLoading={deleteMutation.isPending}
        okText="Ўчириш"
        okButtonProps={{ danger: true }}
        cancelText="Бекор қилиш"
        destroyOnHidden
      >
        <Alert
          type="warning"
          message="Диққат"
          description="Ушбу далил ўчирилганда, тегишли Мавзунинг умумлашмаси ва статистик кўрсаткичлари автоматик қайта ҳисобланади."
          showIcon
          style={{ marginBottom: 16 }}
        />
        <Form form={deleteForm} layout="vertical" onFinish={handleDelete}>
          <Form.Item
            name="changeReason"
            label="Ўчириш сабаби (Аудит учун)"
            rules={[{ required: true, min: 3, message: 'Камида 3 та белги киритинг' }]}
          >
            <TextArea
              rows={3}
              placeholder="Масалан: Хабар спам бўлиб, нотўғри қабул қилинган эди."
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
};
