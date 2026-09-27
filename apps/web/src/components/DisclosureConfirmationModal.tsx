import React, { useState, useEffect } from 'react';
import { Modal, Button, Typography, Alert, Space } from 'antd';
import { useDistrictReadiness } from '../district/useDistrictReadiness.js';
import { useDistrict } from '../district/district-context.js';
import { ApiError } from '../lib/api-client.js';
import { useOnlineStatus } from '../hooks/useOnlineStatus.js';

const { Paragraph, Text } = Typography;

interface DisclosureConfirmationModalProps {
  open: boolean;
  onClose: () => void;
  districtId: string;
  districtName?: string;
  onSuccess?: () => void;
}

export const DisclosureConfirmationModal: React.FC<DisclosureConfirmationModalProps> = ({
  open,
  onClose,
  districtId,
  districtName,
  onSuccess,
}) => {
  const { confirmDisclosure, isConfirming } = useDistrictReadiness(districtId);
  const { clearDirty } = useDistrict();
  const [serverError, setServerError] = useState<string | null>(null);
  const isOffline = useOnlineStatus();

  useEffect(() => {
    if (open) {
      setServerError(null);
    }
  }, [open]);

  const handleClose = () => {
    clearDirty('disclosure-confirmation-modal');
    setServerError(null);
    onClose();
  };

  const handleConfirm = async () => {
    if (isOffline) {
      setServerError('Сервер билан алоқа мавжуд эмас. Тармоқни текширинг.');
      return;
    }

    setServerError(null);
    try {
      await confirmDisclosure();
      clearDirty('disclosure-confirmation-modal');
      if (onSuccess) {
        onSuccess();
      }
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setServerError(err.message);
      } else {
        setServerError('Сервер билан боғланишда хатолик юз берди. Илтимос, қайта уриниб кўринг.');
      }
    }
  };

  return (
    <Modal
      title="Операцион кириш очиқлигини тасдиқлаш"
      open={open}
      onCancel={handleClose}
      destroyOnHidden
      centered
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <Button
            id="confirm-disclosure-cancel"
            onClick={handleClose}
            disabled={isConfirming}
            style={{ minHeight: 44 }}
          >
            Бекор қилиш
          </Button>
          <Button
            id="confirm-disclosure-submit"
            type="primary"
            onClick={handleConfirm}
            loading={isConfirming}
            disabled={isConfirming || isOffline}
            style={{ minHeight: 44 }}
          >
            Тасдиқлаш ва сақлаш
          </Button>
        </div>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%', padding: '12px 0' }}>
        {isOffline && (
          <Alert
            type="warning"
            showIcon
            message="Сервер билан алоқа мавжуд эмас. Тармоқни текширинг."
          />
        )}

        {serverError && !isOffline && (
          <Alert
            type="error"
            showIcon
            message="Тасдиқлашда хатолик"
            description={serverError}
          />
        )}

        <Paragraph>
          {districtName ? (
            <>
              <strong>{districtName}</strong> бўйича тизим созламалари ва ташқи операцион кириш
              очиқлигини расман тасдиқлайсизми?
            </>
          ) : (
            'Мазкур туман бўйича тизим созламалари ва ташқи операцион кириш очиқлигини расман тасдиқлайсизми?'
          )}
        </Paragraph>

        <Alert
          type="info"
          showIcon
          message="Хавфсизлик ва аудит талаби"
          description="Ушбу тасдиқлов қайд этилгандан сўнг, тизим аудит журналида масъул ходим идентификатори ва вақти қайд этилади. Тасдиқлов фақат масъул шахс томонидан амалга оширилиши шарт."
        />

        <Text type="secondary" style={{ fontSize: 13 }}>
          Тасдиқлаш учун «Тасдиқлаш ва сақлаш» тугмасини босинг.
        </Text>
      </Space>
    </Modal>
  );
};
