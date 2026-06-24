/**
 * Open Design — Title Bar Title
 *
 * Displays the window title text in the title bar.
 * Supports children as a slot for custom content (e.g., breadcrumbs).
 *
 * @module components/title-bar/title-bar-title
 */

import React from "react";
import styles from "./title-bar.module.css";

/** Props for the TitleBarTitle component. */
export interface TitleBarTitleProps {
  /** The window title text. Falls back to the children slot. */
  title?: string;

  /** Optional children to render instead of the title text. */
  children?: React.ReactNode;
}

/**
 * Window title text display.
 *
 * Shows the application/window title with text-overflow: ellipsis
 * for long titles. Supports custom children via slot pattern.
 */
export const TitleBarTitle: React.FC<TitleBarTitleProps> = ({
  title,
  children,
}) => {
  const content: React.ReactNode = children ?? title ?? "";

  return (
    <div className={styles.titleBar_title}>
      {content}
    </div>
  );
};

export default TitleBarTitle;
