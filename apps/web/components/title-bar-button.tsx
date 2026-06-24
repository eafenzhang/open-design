/**
 * Open Design — Title Bar Button
 *
 * A single window control button (minimize, maximize/restore, close).
 * Renders an inline SVG icon using currentColor, with hover/active
 * styles via CSS classes. The close button gets a special red hover.
 *
 * @module components/title-bar/title-bar-button
 */

import React from "react";
import styles from "./title-bar.module.css";

/** Supported button types. */
export type TitleBarButtonType = "minimize" | "maximize" | "restore" | "close";

/** Props for the TitleBarButton component. */
export interface TitleBarButtonProps {
  /** The type of window control button. */
  type: TitleBarButtonType;

  /** Click handler. */
  onClick: () => void;

  /** Accessible label for screen readers. */
  ariaLabel: string;

  /** Whether the button is disabled. */
  disabled?: boolean;
}

/**
 * Window control button with inline SVG icon.
 *
 * Button dimensions:
 * - Win10: 46×32px
 * - Win11: 48×36px (default)
 *
 * The close button uses .titleBar_buttonClose for red hover styling.
 */
export const TitleBarButton: React.FC<TitleBarButtonProps> = ({
  type,
  onClick,
  ariaLabel,
  disabled = false,
}) => {
  const classNames: string[] = [styles.titleBar_button, styles.titleBar_noDrag];

  if (type === "close") {
    classNames.push(styles.titleBar_buttonClose);
  }

  const className: string = classNames.join(" ");

  return (
    <button
      className={className}
      onClick={onClick}
      aria-label={ariaLabel}
      disabled={disabled}
      tabIndex={-1}
    >
      {renderIcon(type)}
    </button>
  );
};

/**
 * Render the appropriate SVG icon for the button type.
 * All icons use currentColor for theming support.
 */
function renderIcon(type: TitleBarButtonType): React.ReactElement {
  switch (type) {
    case "minimize":
      return (
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
        >
          <rect x="0.5" y="4.5" width="9" height="1" fill="currentColor" />
        </svg>
      );

    case "maximize":
      return (
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
        >
          <rect
            x="0.5"
            y="0.5"
            width="9"
            height="9"
            stroke="currentColor"
            strokeWidth="1"
            fill="none"
          />
        </svg>
      );

    case "restore":
      return (
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
        >
          {/* Back window */}
          <rect
            x="2"
            y="0.5"
            width="7.5"
            height="7.5"
            stroke="currentColor"
            strokeWidth="1"
            fill="none"
          />
          {/* Front window */}
          <rect
            x="0.5"
            y="2"
            width="7.5"
            height="7.5"
            stroke="currentColor"
            strokeWidth="1"
            fill="var(--titlebar-bg, #1e1e1e)"
          />
        </svg>
      );

    case "close":
      return (
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
        >
          <line
            x1="0.5"
            y1="0.5"
            x2="9.5"
            y2="9.5"
            stroke="currentColor"
            strokeWidth="1"
          />
          <line
            x1="9.5"
            y1="0.5"
            x2="0.5"
            y2="9.5"
            stroke="currentColor"
            strokeWidth="1"
          />
        </svg>
      );

    default:
      return <span />;
  }
}

export default TitleBarButton;
