import { useCallback, useEffect, useRef, useState } from "react";

export interface ChatDetailRequestToken {
  chatId: string;
  revision: number;
}

/**
 * Owns the async boundaries shared by chat selection, detail pagination,
 * authoritative refreshes, and new-chat navigation. A response may update the
 * view only while its token is still current for the mounted selection.
 */
export function useChatSessionController() {
  const mountedRef = useRef(false);
  const selectedChatIdRef = useRef<string | null>(null);
  const detailRevisionRef = useRef(0);
  const navigationRevisionRef = useRef(0);
  const createPromiseRef = useRef<Promise<unknown> | null>(null);
  const creationRevisionRef = useRef(0);
  const [creatingChat, setCreatingChat] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      selectedChatIdRef.current = null;
    };
  }, []);

  const selectChat = useCallback((chatId: string): ChatDetailRequestToken => {
    selectedChatIdRef.current = chatId;
    navigationRevisionRef.current += 1;
    return { chatId, revision: ++detailRevisionRef.current };
  }, []);

  const beginDetailRequest = useCallback((chatId: string): ChatDetailRequestToken => {
    return { chatId, revision: ++detailRevisionRef.current };
  }, []);

  const ownsDetailRequest = useCallback((token: ChatDetailRequestToken): boolean => {
    return (
      mountedRef.current && selectedChatIdRef.current === token.chatId && detailRevisionRef.current === token.revision
    );
  }, []);

  const clearSelection = useCallback((chatId?: string) => {
    if (chatId && selectedChatIdRef.current !== chatId) return;
    selectedChatIdRef.current = null;
    detailRevisionRef.current += 1;
    navigationRevisionRef.current += 1;
  }, []);

  const currentChatId = useCallback(() => selectedChatIdRef.current, []);
  const isMounted = useCallback(() => mountedRef.current, []);

  const createChat = useCallback(
    async <T>(create: () => Promise<T>, onCreated: (created: T) => Promise<void> | void): Promise<T> => {
      if (createPromiseRef.current) return createPromiseRef.current as Promise<T>;

      const creationRevision = ++creationRevisionRef.current;
      const navigationRevision = navigationRevisionRef.current;
      if (mountedRef.current) setCreatingChat(true);

      const request = (async () => {
        const created = await create();
        if (
          mountedRef.current &&
          creationRevisionRef.current === creationRevision &&
          navigationRevisionRef.current === navigationRevision
        ) {
          await onCreated(created);
        }
        return created;
      })();
      createPromiseRef.current = request;

      try {
        return await request;
      } finally {
        if (creationRevisionRef.current === creationRevision) {
          createPromiseRef.current = null;
          if (mountedRef.current) setCreatingChat(false);
        }
      }
    },
    [],
  );

  return {
    selectedChatIdRef,
    creatingChat,
    selectChat,
    beginDetailRequest,
    ownsDetailRequest,
    clearSelection,
    currentChatId,
    isMounted,
    createChat,
  };
}
