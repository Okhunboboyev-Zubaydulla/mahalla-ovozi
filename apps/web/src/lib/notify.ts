import { App } from 'antd';
import { getErrorMessage } from './error-message.js';

/**
 * The single toast surface for mutation feedback.
 *
 * Obtained through `useNotify()`, which reads antd's contextual message API via
 * `App.useApp()` so toasts inherit the theme and the ConfigProvider scope. The
 * hook must therefore be called from a component rendered inside `<AntdApp>`
 * (mounted once in `App.tsx`), not from a plain lib function.
 */
export interface Notify {
  notifySuccess: (text: string) => void;
  notifyError: (error: unknown, fallback: string) => void;
}

export function useNotify(): Notify {
  const { message } = App.useApp();

  return {
    notifySuccess: (text: string) => {
      void message.success(text);
    },
    notifyError: (error: unknown, fallback: string) => {
      void message.error(getErrorMessage(error, fallback));
    },
  };
}
