import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
  ReactNode,
} from 'react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { useInRouterContext, useSearchParams } from 'react-router-dom';
import { districtClient } from './district-client.js';
import { districtQueryKeys } from './query-keys.js';

export const DISTRICT_STORAGE_KEY = 'mahalla_active_district_id';

export interface DistrictContextValue {
  activeDistrictId: string | null;
  switchDistrict: (nextId: string) => Promise<void>;
  setActiveDistrictDirectly: (id: string | null) => void;
  registerDirty: (id: string) => void;
  clearDirty: (id: string) => void;
  hasDirtyForms: boolean;
  pendingTransition: (() => void) | null;
  confirmDiscard: () => void;
  cancelTransition: () => void;
  attemptTransition: (action: () => void | Promise<void>) => void;
}

const DistrictContext = createContext<DistrictContextValue | null>(null);

function DistrictRouterSync({
  activeDistrictId,
  setActiveDistrictId,
}: {
  activeDistrictId: string | null;
  setActiveDistrictId: (id: string | null) => void;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const searchParamDistrictId = searchParams.get('districtId');
  const activeRef = useRef<string | null>(activeDistrictId);
  activeRef.current = activeDistrictId;

  // 1. Synchronize URL query parameter when activeDistrictId changes
  useEffect(() => {
    const currentQueryId = searchParams.get('districtId');
    if (activeDistrictId && currentQueryId !== activeDistrictId) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('districtId', activeDistrictId);
          return next;
        },
        { replace: true }
      );
    } else if (!activeDistrictId && currentQueryId) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('districtId');
          return next;
        },
        { replace: true }
      );
    }
  }, [activeDistrictId, searchParams, setSearchParams]);

  // 2. Synchronize state if URL search param changes externally (e.g. browser navigation)
  useEffect(() => {
    if (searchParamDistrictId && searchParamDistrictId !== activeRef.current) {
      if (typeof window !== 'undefined') {
        localStorage.setItem(DISTRICT_STORAGE_KEY, searchParamDistrictId);
      }
      setActiveDistrictId(searchParamDistrictId);
    }
  }, [searchParamDistrictId, setActiveDistrictId]);

  return null;
}

export function DistrictProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const inRouter = useInRouterContext();

  const [activeDistrictId, setActiveDistrictId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const urlParams = new URLSearchParams(window.location.search);
    const paramId = urlParams.get('districtId');
    if (paramId) {
      localStorage.setItem(DISTRICT_STORAGE_KEY, paramId);
      return paramId;
    }
    return localStorage.getItem(DISTRICT_STORAGE_KEY) || null;
  });

  const [dirtySet, setDirtySet] = useState<Set<string>>(new Set());
  const [pendingTransition, setPendingTransition] = useState<(() => void) | null>(null);

  const activeDistrictIdRef = useRef<string | null>(activeDistrictId);
  activeDistrictIdRef.current = activeDistrictId;

  const hasDirtyForms = dirtySet.size > 0;

  // Validate active district against loaded districts list (Auto-cleanse invalid/deleted IDs)
  const { data: districtsData } = useQuery({
    queryKey: ['districts', 'list'],
    queryFn: districtClient.listDistricts,
    staleTime: 30 * 1000,
  });

  useEffect(() => {
    if (!districtsData?.districts || !activeDistrictId) return;
    const exists = districtsData.districts.some((d) => d.id === activeDistrictId);
    if (!exists) {
      if (typeof window !== 'undefined') {
        localStorage.removeItem(DISTRICT_STORAGE_KEY);
      }
      setActiveDistrictId(null);
    }
  }, [districtsData, activeDistrictId]);

  const registerDirty = useCallback((id: string) => {
    setDirtySet((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const clearDirty = useCallback((id: string) => {
    setDirtySet((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const switchSeqRef = useRef<number>(0);

  // P4-B: Atomic district switch sequence in strict order
  const executeSwitch = useCallback(
    async (nextId: string | null) => {
      const seq = ++switchSeqRef.current;
      const prevId = activeDistrictIdRef.current;

      // 1. Update localStorage persistence immediately
      if (typeof window !== 'undefined') {
        if (nextId) {
          localStorage.setItem(DISTRICT_STORAGE_KEY, nextId);
        } else {
          localStorage.removeItem(DISTRICT_STORAGE_KEY);
        }
      }

      if (prevId && prevId !== nextId) {
        // 2. Signal abort to in-flight prior-district queries (async — await settlement)
        await queryClient.cancelQueries({ queryKey: districtQueryKeys.district(prevId) });
        await queryClient.cancelQueries({
          predicate: (query) =>
            query.queryKey.some((part) => typeof part === 'string' && part === prevId),
        });
        // 3. Purge prior-district cache (sync — must fire AFTER cancelQueries resolves)
        queryClient.removeQueries({ queryKey: districtQueryKeys.district(prevId) });
        queryClient.removeQueries({
          predicate: (query) =>
            query.queryKey.some((part) => typeof part === 'string' && part === prevId),
        });
      }
      // Drop late execution if a newer switch was initiated
      if (seq !== switchSeqRef.current) return;
      // 4. Clear local interaction state & dirty registry
      setDirtySet(new Set());

      // 5. Activate new district context
      setActiveDistrictId(nextId);
    },
    [queryClient]
  );

  const attemptTransition = useCallback(
    (action: () => void | Promise<void>) => {
      if (dirtySet.size > 0) {
        setPendingTransition(() => async () => {
          setDirtySet(new Set());
          await action();
        });
      } else {
        void action();
      }
    },
    [dirtySet]
  );

  const switchDistrict = useCallback(
    async (nextId: string) => {
      if (nextId === activeDistrictIdRef.current) return;

      if (dirtySet.size > 0) {
        setPendingTransition(() => () => {
          void executeSwitch(nextId);
        });
      } else {
        await executeSwitch(nextId);
      }
    },
    [dirtySet, executeSwitch]
  );

  const setActiveDistrictDirectly = useCallback(
    (id: string | null) => {
      void executeSwitch(id);
    },
    [executeSwitch]
  );

  const confirmDiscard = useCallback(() => {
    if (pendingTransition) {
      const transitionToRun = pendingTransition;
      setPendingTransition(null);
      setDirtySet(new Set());
      transitionToRun();
    }
  }, [pendingTransition]);

  const cancelTransition = useCallback(() => {
    setPendingTransition(null);
  }, []);

  const contextValue = useMemo(
    (): DistrictContextValue => ({
      activeDistrictId,
      switchDistrict,
      setActiveDistrictDirectly,
      registerDirty,
      clearDirty,
      hasDirtyForms,
      pendingTransition,
      confirmDiscard,
      cancelTransition,
      attemptTransition,
    }),
    [
      activeDistrictId,
      switchDistrict,
      setActiveDistrictDirectly,
      registerDirty,
      clearDirty,
      hasDirtyForms,
      pendingTransition,
      confirmDiscard,
      cancelTransition,
      attemptTransition,
    ]
  );

  return (
    <DistrictContext.Provider value={contextValue}>
      {inRouter && (
        <DistrictRouterSync
          activeDistrictId={activeDistrictId}
          setActiveDistrictId={setActiveDistrictId}
        />
      )}
      {children}
    </DistrictContext.Provider>
  );
}

export function useDistrict(): DistrictContextValue {
  const context = useContext(DistrictContext);
  if (!context) {
    throw new Error('useDistrict must be used within a DistrictProvider');
  }
  return context;
}
