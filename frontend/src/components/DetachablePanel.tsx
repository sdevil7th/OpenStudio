import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface DetachablePanelProps {
  title: string;
  width?: number;
  height?: number;
  isDetached: boolean;
  onDetach: () => void;
  onAttach: () => void;
  children: React.ReactNode;
}

export function DetachablePanel({
  title,
  width = 800,
  height = 400,
  isDetached,
  onDetach,
  onAttach,
  children,
}: DetachablePanelProps) {
  const externalWindow = useRef<Window | null>(null);
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isDetached) {
      if (externalWindow.current && !externalWindow.current.closed) {
        externalWindow.current.close();
      }
      externalWindow.current = null;
      setContainerEl(null);
      return;
    }

    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;

    const win = window.open(
      "",
      `studio13_${title.toLowerCase().replace(/\s+/g, "_")}`,
      `width=${width},height=${height},left=${left},top=${top},resizable=yes`,
    );

    if (!win) {
      onAttach();
      return;
    }

    externalWindow.current = win;

    win.document.title = `${title} - Studio13`;

    const container = win.document.createElement("div");
    container.id = "detached-root";
    win.document.body.appendChild(container);

    win.document.body.style.margin = "0";
    win.document.body.style.padding = "0";
    win.document.body.style.overflow = "hidden";
    win.document.body.style.backgroundColor = "#121212";

    const parentStyleSheets = document.querySelectorAll(
      'style, link[rel="stylesheet"]',
    );
    parentStyleSheets.forEach((node) => {
      const clone = node.cloneNode(true) as HTMLElement;
      win.document.head.appendChild(clone);
    });

    setContainerEl(container);

    const handleUnload = () => {
      onAttach();
    };
    win.addEventListener("beforeunload", handleUnload);

    return () => {
      win.removeEventListener("beforeunload", handleUnload);
      if (!win.closed) {
        win.close();
      }
      externalWindow.current = null;
      setContainerEl(null);
    };
  }, [isDetached, title, width, height, onAttach, onDetach]);

  if (isDetached && containerEl) {
    return createPortal(children, containerEl);
  }

  return <>{children}</>;
}
