/**
 * Open Design — Title Bar Controls
 *
 * Container for the three standard Windows window control buttons:
 * minimize, maximize/restore, and close. Handles the maximize/restore
 * toggle state and delegates button clicks to the electronAPI.
 *
 * @module components/title-bar/title-bar-controls
 */

import React, { useCallback } from "react";
import { TitleBarButton } from "./title-bar-button.js";
import type { TitleBarButtonType } from "./title-bar-button.js";
import styles from "./title-bar.module.css";

/** Props for the TitleBarControls component. */
export interface TitleBarControlsProps {
  /** Whether the window is currently maximized. */
  isMaximized: boolean;

  /** Called when minimize button is clicked. */
  onMinimize: () => void;

  /** Called when maximize/restore button is clicked. */
  onMaximize: () => void;

  /** Called when close button is clicked. */
  onClose: () => void;
}

/**
 * Window control buttons group (min/max/close).
 *
 * All buttons are rendered inside a -webkit-app-region: no-drag
 * container so they remain clickable within the drag region.
 */
export const TitleBarControls: React.FC<TitleBarControlsProps> = ({
  isMaximized,
  onMinimize,
  onMaximize,
  onClose,
}) => {
  const maximizeType: TitleBarButtonType = isMaximized ? "restore" : "maximize";
  const maximizeLabel: string = isMaximized ? "Restore Down" : "Maximize";

  const handleMinimize = useCallback(() => {
    onMinimize();
  }, [onMinimize]);

  const handleMaximize = useCallback(() => {
    onMaximize();
  }, [onMaximize]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  return (
    <div className={`${styles.titleBar_controls} ${styles.titleBar_noDrag}`}>
      <TitleBarButton
        type="minimize"
        onClick={handleMinimize}
        ariaLabel="Minimize"
      />
      <TitleBarButton
        type={maximizeType}
        onClick={handleMaximize}
        ariaLabel={maximizeLabel}
      />
      <TitleBarButton
        type="close"
        onClick={handleClose}
        ariaLabel="Close"
      />
    </div>
  );
};

export default TitleBarControls;
