/**
 * Open Design — Title Bar Icon
 *
 * Displays the application icon (16×16 SVG) in the title bar.
 * Supports left-click to show the system menu and right-click
 * for the native context menu.
 *
 * @module components/title-bar/title-bar-icon
 */

import React, { useCallback } from "react";
import styles from "./title-bar.module.css";

/** Props for the TitleBarIcon component. */
export interface TitleBarIconProps {
  /** Called when the icon is clicked (left-click). Opens system menu. */
  onSystemMenu: () => void;

  /** Called when the icon is right-clicked. Opens native context menu. */
  onContextMenu: () => void;

  /** Optional custom icon URL. Falls back to default SVG if not provided. */
  iconUrl?: string;

  /** Accessible label for the icon. */
  ariaLabel?: string;
}

/**
 * Application icon in the title bar (16×16).
 *
 * Left-click triggers the system menu (restore/move/size/minimize/maximize/close).
 * Right-click triggers the native context menu.
 */
export const TitleBarIcon: React.FC<TitleBarIconProps> = ({
  onSystemMenu,
  onContextMenu,
  iconUrl,
  ariaLabel = "Application Menu",
}) => {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onSystemMenu();
    },
    [onSystemMenu],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu();
    },
    [onContextMenu],
  );

  return (
    <div
      className={`${styles.titleBar_icon} ${styles.titleBar_noDrag}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      role="button"
      aria-label={ariaLabel}
      tabIndex={-1}
    >
      {iconUrl ? (
        <img
          src={iconUrl}
          alt={ariaLabel}
          width={16}
          height={16}
          draggable={false}
        />
      ) : (
        <DefaultIcon />
      )}
    </div>
  );
};

/** Default application icon SVG (16×16). */
function DefaultIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="1"
        y="1"
        width="14"
        height="14"
        rx="2"
        fill="currentColor"
        opacity="0.15"
      />
      <rect
        x="1"
        y="1"
        width="14"
        height="14"
        rx="2"
        stroke="currentColor"
        strokeWidth="1"
        fill="none"
      />
      {/* Abstract "O" and "D" shapes for Open Design */}
      <circle cx="6" cy="8" r="2.5" stroke="currentColor" strokeWidth="1" fill="none" />
      <line x1="9" y1="5.5" x2="12" y2="5.5" stroke="currentColor" strokeWidth="1" />
      <line x1="9" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1" />
      <line x1="12" y1="5.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

export default TitleBarIcon;
