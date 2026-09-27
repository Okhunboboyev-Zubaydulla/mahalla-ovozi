export function formatTashkentDate(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return isoString;
    return new Intl.DateTimeFormat('uz-UZ', {
      timeZone: 'Asia/Tashkent',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return isoString;
  }
}

export function formatTashkentTime(isoString: string | null | undefined): string {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('uz-UZ', {
      timeZone: 'Asia/Tashkent',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return '';
  }
}

export interface TashkentLiveDateTime {
  display: string;
  compact: string;
  full: string;
}

export function formatTashkentLiveDateTime(input?: string | Date | null): TashkentLiveDateTime {
  if (!input) {
    return { display: '', compact: '', full: '' };
  }
  try {
    const date = typeof input === 'string' ? new Date(input) : input;
    if (Number.isNaN(date.getTime())) {
      return { display: '', compact: '', full: '' };
    }

    const parts = new Intl.DateTimeFormat('uz-UZ', {
      timeZone: 'Asia/Tashkent',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);

    const day = parts.find((p) => p.type === 'day')?.value ?? '00';
    const month = parts.find((p) => p.type === 'month')?.value ?? '00';
    const year = parts.find((p) => p.type === 'year')?.value ?? '0000';
    const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';

    const dateStr = `${day}.${month}.${year}`;
    const compactDateStr = `${day}.${month}`;
    const timeStr = `${hour}:${minute}`;

    return {
      display: `${dateStr} · ${timeStr}`,
      compact: `${compactDateStr} · ${timeStr}`,
      full: `${dateStr}, ${timeStr} (Тошкент вақти)`,
    };
  } catch {
    return { display: '', compact: '', full: '' };
  }
}

export function formatTashkentActivityTime(isoString: string, currentCalendarDay?: string): string {
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '';

    const todayYmd =
      currentCalendarDay ||
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tashkent',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());

    const itemYmd = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tashkent',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);

    if (itemYmd === todayYmd) {
      return new Intl.DateTimeFormat('uz-UZ', {
        timeZone: 'Asia/Tashkent',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date);
    }

    return new Intl.DateTimeFormat('uz-UZ', {
      timeZone: 'Asia/Tashkent',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return '';
  }
}

export function formatTashkentRelativeTime(isoString?: string | null): string {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '';
    const now = Date.now();
    const diffMs = now - date.getTime();
    if (diffMs < 0) return 'ҳозиргина';
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return 'ҳозиргина';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} дақ олдин`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours} соат олдин`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} кун олдин`;
  } catch {
    return '';
  }
}

export function formatTashkentCalendarDate(calendarDay: string): string {
  try {
    if (calendarDay.includes('..')) {
      const [from, to] = calendarDay.split('..');
      if (from && to) {
        return `${formatTashkentCalendarDate(from)} – ${formatTashkentCalendarDate(to)}`;
      }
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(calendarDay)) {
      const [year, month, day] = calendarDay.split('-');
      return `${day}.${month}.${year}`;
    }
    const date = new Date(calendarDay);
    return new Intl.DateTimeFormat('uz-UZ', {
      timeZone: 'Asia/Tashkent',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return calendarDay;
  }
}

export { getTashkentToday } from '@mahalla-ovozi/api-contracts';

const ACTION_DISPLAY_NAMES_UZ: Record<string, string> = {
  AUTH_SIGN_IN_SUCCESS: 'Тизимга муваффақиятли кириш',
  AUTH_SIGN_IN_FAILURE: 'Тизимга киришда хатолик',
  ACCOUNT_PO_CREATED: 'Маҳсулот эгаси ҳисоби яратилди',
  ACCOUNT_PO_PASSWORD_RESET: 'Маҳсулот эгаси пароли янгиланди',
  AUTH_FIRST_LOGIN_PASSWORD_CHANGE_FAILED: 'Биринчи кириш паролини ўзгартиришда хатолик',
  ACCOUNT_HOKIM_CREATED: 'Туман ҳокими ҳисоби яратилди',
  ACCOUNT_HOKIM_FIRST_LOGIN_PASSWORD_CHANGED: 'Ҳокимнинг бошланғич пароли ўзгартирилди',
  ACCOUNT_HOKIM_PASSWORD_RESET: 'Ҳоким пароли вақтинчалик янгиланди',
  ACCOUNT_HOKIM_DISABLED: 'Ҳоким ҳисоби тўхтатилди',
  ACCOUNT_HOKIM_REPLACED: 'Ҳоким янгисига алмаштирилди',
  DISTRICT_CREATED: 'Янги туман яратилди',
  DISTRICT_UPDATED: 'Туман маълумотлари янгиланди',
  DISTRICT_DISCLOSURE_CONFIRMED: 'Маълумотларни ошкор қилиш тасдиқланди',
  DISTRICT_ACTIVATED: 'Туман муваффақиятли фаоллаштирилди',
  DISTRICT_ACTIVATION_FAILED: 'Туманни фаоллаштиришда хатолик',
  DISTRICT_TELEGRAM_BOT_CONNECTED: 'Телеграм бот муваффақиятли уланди',
  DISTRICT_TELEGRAM_BOT_DISCONNECTED: 'Телеграм бот уланиши узилди',
  DISTRICT_GROUP_VALIDATED: 'Телеграм гуруҳ текширилди',
  DISTRICT_GROUP_MAPPED: 'Телеграм гуруҳ маҳаллага бириктирилди',
  DISTRICT_GROUP_REMAPPED: 'Телеграм гуруҳ маҳаллага қайта бириктирилди',
  DISTRICT_GROUP_UNMAPPED: 'Телеграм гуруҳ бириктируви бекор қилинди',
  OPERATIONAL_ISSUE_DETECTED: 'Операцион муаммо аниқланди',
  OPERATIONAL_ISSUE_RESOLVED: 'Операцион муаммо бартараф этилди',
  OPERATIONAL_RETRY_TRIGGERED: 'Қайта уриниш амали ишга туширилди',
  DISTRICT_SUBSCRIPTION_METADATA_UPDATED: 'Обуна маълумотлари янгиланди',
  DISTRICT_GRACE_STARTED: 'Имтиёзли давр (Grace) бошланди',
  DISTRICT_SUBSCRIPTION_SUSPENDED: 'Обуна тўхтатилди (Suspended)',
  DISTRICT_SERVICE_RESTORED_ACTIVE: 'Фаол ҳолат тикланди',
  DISTRICT_CANCELLED: 'Туман бекор қилинди (Cancelled)',
  DISTRICT_RECOVERY_STARTED: 'Туманни тиклаш бошланди (Recovery Started)',
  DISTRICT_LIVE_DELETED: 'Туман жонли тизимдан бутунлай ўчирилди (Live Deletion Completed)',
  DISTRICT_LIVE_DELETION_FAILED: 'Туманни жонли тизимдан ўчиришда хатолик',
  DISTRICT_BACKUP_EXPIRY_VERIFIED: 'Туманнинг заҳира нусхалари муддати муваффақиятли тасдиқланди',
  DISTRICT_BACKUP_EXPIRY_FAILED: 'Туманнинг заҳира нусхалари муддатини тасдиқлашда хатолик юз берди',
  DISTRICT_RESTORE_RECONCILED: 'Фалокатдан тикланиш мувофиқлаштирилди',
  DISTRICT_RESTORE_RECONCILIATION_FAILED: 'Фалокатдан тикланишни мувофиқлаштиришда хатолик',
  DISTRICT_PERMANENT_DELETION_PROOF: 'Ўчирилганлик маълумотномаси',
};

export function getActionDisplayNameUz(action: string): string {
  if (ACTION_DISPLAY_NAMES_UZ[action]) {
    return ACTION_DISPLAY_NAMES_UZ[action];
  }
  return action.replace(/_/g, ' ');
}

export function formatScheduledTransitionType(type?: string | null): string {
  if (!type) return '';
  switch (type) {
    case 'AUTOMATIC_SUSPENSION':
      return 'Автоматик тўхтатиш';
    case 'LIVE_DELETION':
      return 'Тўлиқ ўчириш';
    default:
      return type;
  }
}

export function formatBackupExpiryStatus(status?: string | null): string {
  if (!status) return '';
  switch (status) {
    case 'PENDING':
      return 'Заҳира муддати кутилмоқда (Pending)';
    case 'VERIFIED':
      return 'Заҳира муддати муваффақиятли тасдиқланди (Verified)';
    case 'FAILED':
      return 'Заҳира муддатини тасдиқлашда хатолик (Failed)';
    default:
      return status;
  }
}

export function getRecordTypeDisplayNameUz(type?: string | null): string {
  if (type === 'PERMANENT_DELETION_PROOF') {
    return 'Ўчирилганлик маълумотномаси';
  }
  return 'Аудит ҳодисаси';
}

export function getLiveDeletionStatusDisplayNameUz(status?: string | null): string {
  if (status === 'COMPLETED') {
    return 'Якунланган';
  }
  if (status === 'FAILED') {
    return 'Хатолик';
  }
  return status || '—';
}

export function getRestoreReconciliationStatusDisplayNameUz(status?: string | null): string {
  if (!status) return '—';
  switch (status) {
    case 'PENDING':
      return 'Кутилмоқда (Pending)';
    case 'RECONCILED':
      return 'Тасдиқланган (Reconciled)';
    case 'FAILED':
      return 'Хатолик (Failed)';
    default:
      return status;
  }
}

