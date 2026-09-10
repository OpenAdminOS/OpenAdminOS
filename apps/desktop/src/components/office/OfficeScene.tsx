import type { OfficePersona } from "../../shared/openAdminOS";

export function PersonaAvatar({
  avatar,
  color,
}: Pick<OfficePersona, "avatar" | "color">) {
  return (
    <svg
      className={`persona-avatar persona-${color}`}
      viewBox="0 0 100 100"
      aria-hidden="true"
    >
      <ellipse
        cx="50"
        cy="91"
        rx="26"
        ry="5"
        fill="currentColor"
        opacity=".12"
      />
      <path d="M30 73v13h12V75m16 0v11h12V73" fill="currentColor" />
      <rect x="26" y="49" width="48" height="31" rx="12" fill="currentColor" />
      <path
        className="persona-hands"
        d="M27 57l-9 11m55-11 9 11"
        stroke="currentColor"
        strokeWidth="9"
        strokeLinecap="round"
      />
      {avatar === "robot" ? (
        <>
          <path d="M50 25V13" stroke="currentColor" strokeWidth="4" />
          <circle cx="50" cy="11" r="5" fill="currentColor" />
          <rect
            x="20"
            y="25"
            width="60"
            height="39"
            rx="13"
            fill="currentColor"
          />
          <rect x="27" y="32" width="46" height="24" rx="8" fill="#24211f" />
        </>
      ) : (
        <>
          <path
            d={
              avatar === "owl"
                ? "M21 39 18 17 39 28Q50 22 61 28L82 17 79 39"
                : "M22 39 24 12 43 28H57L76 12 78 39"
            }
            fill="currentColor"
          />
          <ellipse cx="50" cy="44" rx="31" ry="25" fill="currentColor" />
          {avatar === "owl" && (
            <>
              <circle cx="37" cy="43" r="13" fill="#f5f1eb" opacity=".8" />
              <circle cx="63" cy="43" r="13" fill="#f5f1eb" opacity=".8" />
            </>
          )}
          {avatar === "fox" && (
            <path
              d="M22 43 50 67 78 43 59 49 50 42 41 49Z"
              fill="#f5f1eb"
              opacity=".8"
            />
          )}
        </>
      )}
      <rect
        x="34"
        y="39"
        width="6"
        height="10"
        rx="3"
        fill={avatar === "robot" ? "currentColor" : "#24211f"}
      />
      <rect
        x="60"
        y="39"
        width="6"
        height="10"
        rx="3"
        fill={avatar === "robot" ? "currentColor" : "#24211f"}
      />
      {avatar !== "robot" && <path d="m46 53 4 4 4-4" fill="#24211f" />}
      <rect
        x="41"
        y="68"
        width="18"
        height="4"
        rx="2"
        fill="#24211f"
        opacity=".4"
      />
    </svg>
  );
}

export function OfficeDecor() {
  return (
    <div className="office-wall" aria-hidden="true">
      <div className="office-window">
        <span />
        <span />
        <span />
      </div>
      <div className="office-wall-sign">
        <small>OPENADMINOS</small>
        <strong>Operations office</strong>
        <span>Observe · Investigate · Review</span>
      </div>
      <svg className="office-plant" viewBox="0 0 80 120">
        <path d="M40 94V29" stroke="#728469" strokeWidth="4" />
        <path
          d="M40 70C8 71 2 42 13 37c20-3 29 14 27 33M40 52C63 52 77 24 65 19 48 17 37 33 40 52M40 35C21 33 16 13 27 7c11 0 17 16 13 28"
          fill="#829971"
        />
        <path d="m20 88 6 29h28l6-29" fill="#a98569" />
        <path d="M19 87h42v7H19z" fill="#c09d7e" />
      </svg>
    </div>
  );
}
