"use client";

import Link from "next/link";
import { type FocusEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";

import type { AppScreen } from "./AppShot";
import { AppCrop, AppShot } from "./AppShot";
import type { StageTone } from "./Stage";

export interface TourItem {
  id: string;
  title: string;
  text: string;
  screen: AppScreen;
  alt: string;
  tone: StageTone;
  link?: { href: string; label: string };
}

const ADVANCE_MS = 7000;

/** The app without its sidebar, for the narrow accordion. */
const MOBILE_CROP = { x: 540, y: 0, width: 2020, aspect: "2020 / 1600" } as const;

/**
 * Product areas with the matching real capture on an art stage: tabs over a
 * full-width capture on large screens, an accordion below that. Advances on
 * its own while visible until the visitor picks an item. It pauses while the
 * pointer rests on it or keyboard focus is inside it, and a Pause button stops
 * it outright (WCAG 2.2.2). The progress line drives the advance, so pausing
 * the animation pauses the tour. Reduced motion turns the auto-advance and the
 * transitions off.
 */
export function ProductTour({ items }: { items: readonly TourItem[] }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [active, setActive] = useState(0);
  const [auto, setAuto] = useState(false);
  const [visible, setVisible] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    // Warm the cache with every capture in the active theme before the tour
    // scrolls into view, so switching never shows an empty frame.
    const preload = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        preload.disconnect();
        const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
        for (const item of items) {
          const image = new Image();
          image.decoding = "async";
          image.src = `/app/${item.screen}-${theme}.webp`;
        }
      },
      { rootMargin: "800px 0px" },
    );
    preload.observe(root);

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return () => preload.disconnect();
    }
    setAuto(true);
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(Boolean(entry?.isIntersecting)),
      { threshold: 0.3 },
    );
    observer.observe(root);
    return () => {
      preload.disconnect();
      observer.disconnect();
    };
  }, [items]);

  function choose(index: number) {
    setAuto(false);
    setActive(index);
  }

  function advance() {
    setActive((current) => (current + 1) % items.length);
  }

  // Arrow keys move between tabs, as in the WAI-ARIA tabs pattern.
  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const target =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : step
            ? (active + step + items.length) % items.length
            : -1;
    if (target < 0) return;
    event.preventDefault();
    choose(target);
    tabRefs.current[target]?.focus();
  }

  const tones = [...new Set(items.map((item) => item.tone))];
  const current = items[active]!;
  const running = auto && visible;
  const paused = hovered || focused || stopped;

  function onBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setFocused(false);
    }
  }

  // Only offered while the tour moves on its own; after a pick it stays put.
  const pauseControl = (className: string) =>
    auto ? (
      <button
        type="button"
        onClick={() => setStopped((value) => !value)}
        aria-label={stopped ? "Play the product tour" : "Pause the product tour"}
        title={stopped ? "Play" : "Pause"}
        className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-brand-muted transition-colors hover:bg-brand-hover hover:text-brand-ink ${className}`}
      >
        <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current">
          {stopped ? (
            <path d="M5 3.2v9.6a.6.6 0 0 0 .92.5l7.2-4.8a.6.6 0 0 0 0-1L5.92 2.7A.6.6 0 0 0 5 3.2Z" />
          ) : (
            <path d="M4.5 3h2v10h-2zM9.5 3h2v10h-2z" />
          )}
        </svg>
      </button>
    ) : null;

  const progress = (item: TourItem, className: string) =>
    running ? (
      <span
        aria-hidden
        key={`${item.id}-${active}`}
        onAnimationEnd={advance}
        className={`tour-progress absolute inset-x-0 block h-px bg-brand-ink ${className}`}
        style={{
          animationDuration: `${ADVANCE_MS}ms`,
          animationPlayState: paused ? "paused" : "running",
        }}
      />
    ) : (
      <span aria-hidden className={`absolute inset-x-0 block h-px bg-brand-ink ${className}`} />
    );

  return (
    <div
      ref={rootRef}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
    >
      {/* Large screens: tabs over one full-width capture. */}
      <div className="hidden lg:block">
        <div
          role="tablist"
          aria-label="Product areas"
          onKeyDown={onTabKeyDown}
          className="grid grid-cols-5 gap-8"
        >
          {items.map((item, index) => {
            const isActive = index === active;
            return (
              <button
                key={item.id}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                type="button"
                role="tab"
                id={`tour-tab-${item.id}`}
                aria-selected={isActive}
                aria-controls="tour-tabpanel"
                tabIndex={isActive ? 0 : -1}
                onClick={() => choose(index)}
                className="group relative border-t border-brand-line pt-4 text-left"
              >
                {isActive ? progress(item, "-top-px") : null}
                <span
                  className={`block font-mono text-xs transition-colors duration-300 ${
                    isActive ? "text-brand-ink" : "text-brand-faint"
                  }`}
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span
                  className={`font-display mt-1.5 block text-[1.45rem] leading-tight transition-colors duration-300 ${
                    isActive ? "text-brand-ink" : "text-brand-faint group-hover:text-brand-ink"
                  }`}
                >
                  {item.title}
                </span>
              </button>
            );
          })}
        </div>

        <div
          id="tour-tabpanel"
          role="tabpanel"
          aria-labelledby={`tour-tab-${current.id}`}
          className="mt-8"
        >
          {/*
           * Every description is laid out in the same cell, only the active
           * one visible, so the block keeps the height of the longest and the
           * capture below never moves.
           */}
          <div className="grid max-w-3xl">
            {items.map((item, index) => (
              <div
                key={item.id}
                aria-hidden={index !== active}
                inert={index !== active}
                className={`tour-copy flex flex-wrap items-baseline gap-x-6 gap-y-2 [grid-area:1/1] ${
                  index === active ? "is-active" : ""
                }`}
              >
                <p className="text-[17px] leading-8 text-brand-muted">{item.text}</p>
                {item.link ? (
                  <Link href={item.link.href} className="text-link text-sm">
                    {item.link.label}
                  </Link>
                ) : null}
              </div>
            ))}
          </div>

          <div className="relative mt-10 overflow-hidden rounded-[20px]">
            {tones.map((tone) => (
              <div
                key={tone}
                aria-hidden
                className={`stage stage-${tone} tour-layer ${
                  tone === current.tone ? "is-active" : ""
                }`}
              />
            ))}
            {pauseControl(
              "absolute right-3 top-3 z-20 bg-brand-raised/85 shadow-(--shadow-pop) backdrop-blur",
            )}
            <div className="relative z-10 grid px-12 pt-12">
              {items.map((item, index) => (
                <figure
                  key={item.id}
                  aria-hidden={index !== active}
                  className={`tour-shot overflow-hidden rounded-t-[12px] bg-brand-raised shadow-(--shadow-frame) [grid-area:1/1] ${
                    index === active ? "is-active" : ""
                  }`}
                >
                  <AppShot screen={item.screen} alt={item.alt} className="block h-auto w-full" />
                </figure>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Small screens: an accordion with each capture in its panel. */}
      <ol className="border-t border-brand-line lg:hidden">
        {items.map((item, index) => {
          const isActive = index === active;
          return (
            <li key={item.id} className="relative border-b border-brand-line">
              <button
                type="button"
                aria-expanded={isActive}
                aria-controls={`tour-panel-${item.id}`}
                onClick={() => choose(index)}
                className="group flex w-full items-baseline gap-4 py-5 pr-10 text-left"
              >
                <span
                  className={`w-6 shrink-0 font-mono text-xs transition-colors duration-300 ${
                    isActive ? "text-brand-ink" : "text-brand-faint"
                  }`}
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span
                  className={`font-display text-[1.45rem] leading-tight transition-colors duration-300 ${
                    isActive ? "text-brand-ink" : "text-brand-faint group-hover:text-brand-ink"
                  }`}
                >
                  {item.title}
                </span>
              </button>
              <div
                id={`tour-panel-${item.id}`}
                inert={!isActive}
                className={`tour-panel grid ${isActive ? "is-open" : ""}`}
              >
                <div className="min-h-0 overflow-hidden">
                  <div className="pb-6 pl-10">
                    <p className="text-[15px] leading-7 text-brand-muted">{item.text}</p>
                    {item.link ? (
                      <Link href={item.link.href} className="text-link mt-3 inline-flex text-sm">
                        {item.link.label}
                      </Link>
                    ) : null}
                    <div
                      className={`stage stage-${item.tone} -ml-10 mt-6 overflow-hidden rounded-[14px] px-3 pt-3`}
                    >
                      <AppCrop
                        screen={item.screen}
                        alt={item.alt}
                        {...MOBILE_CROP}
                        className="rounded-t-[8px] bg-brand-raised shadow-(--shadow-frame)"
                      />
                    </div>
                  </div>
                </div>
              </div>
              {isActive ? pauseControl("absolute right-0 top-4") : null}
              {isActive ? progress(item, "-bottom-px") : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
