import { AppCrop, AppShot, type AppScreen } from "./AppShot";

type Crop = { x: number; y: number; width: number; aspect: string };

/**
 * A real desktop capture inside a quiet window frame. The frame is only a
 * title bar; everything inside it is the unedited screenshot.
 */
export function AppWindow({
  screen,
  alt,
  crop,
  title = "OpenAdminOS",
  priority = false,
  className = "",
}: {
  screen: AppScreen;
  alt: string;
  crop?: Crop;
  title?: string;
  priority?: boolean;
  className?: string;
}) {
  return (
    <figure
      className={`overflow-hidden rounded-[12px] bg-brand-raised shadow-(--shadow-frame) ${className}`}
    >
      <div className="relative flex h-8 items-center border-b border-brand-line-soft bg-brand-surface px-3">
        <span aria-hidden className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-brand-line-strong" />
          <span className="h-2.5 w-2.5 rounded-full bg-brand-line-strong" />
          <span className="h-2.5 w-2.5 rounded-full bg-brand-line-strong" />
        </span>
        <span className="absolute inset-x-0 text-center text-[11px] text-brand-faint">
          {title}
        </span>
      </div>
      {crop ? (
        <AppCrop screen={screen} alt={alt} {...crop} />
      ) : (
        <AppShot
          screen={screen}
          alt={alt}
          priority={priority}
          className="block h-auto w-full"
        />
      )}
    </figure>
  );
}
