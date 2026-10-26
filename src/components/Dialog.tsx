import React, { useEffect, useRef } from "react";
export function Dialog({
  children,
  onClose,
  drawer = false,
  label,
}: {
  children: React.ReactNode;
  onClose: () => void;
  drawer?: boolean;
  label?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={label || (drawer ? "Opportunity details" : "Scan a folder")}
      className={drawer ? "drawer" : "modal"}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
