import type { ReactElement } from "react";

import type { UiNotification } from "./notifications";

export function NotificationCenter({
  notifications,
  onDismiss,
}: {
  notifications: UiNotification[];
  onDismiss: (id: string) => void;
}): ReactElement | null {
  if (notifications.length === 0) return null;

  return (
    <section
      className="notification-center"
      aria-label="Terminal notifications"
      aria-live="polite"
      data-testid="notification-center"
    >
      {notifications.map((notification) => (
        <article
          className={`notification is-${notification.kind}`}
          key={notification.id}
          role={
            notification.kind === "error" || notification.kind === "policy" ? "alert" : "status"
          }
        >
          <div>
            <strong>{notification.title}</strong>
            <p>{notification.message}</p>
          </div>
          <button
            type="button"
            aria-label={`Dismiss ${notification.title}`}
            onClick={() => onDismiss(notification.id)}
          >
            ×
          </button>
        </article>
      ))}
    </section>
  );
}
