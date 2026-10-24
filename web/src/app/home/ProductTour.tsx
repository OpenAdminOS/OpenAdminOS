"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type { AppScreen } from "./AppShot";
import { AppShot } from "./AppShot";
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

/**
 * Accordion of product areas with the matching real capture on an art stage.
 * Advances on its own while visible until the visitor picks an item, and
 * pauses while the pointer rests on it. The progress line drives the advance,
 * so pausing the animation pauses the tour. Reduced motion turns the
 * auto-advance and the transitions off.
 */
export function ProductTour({ items }: { items: readonly TourItem[] }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [auto, setAuto] = useState(false);
  const [visible, setVisible] = useState(false);
  const [paused, setPaused] = useState(false);

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

  const tones = [...new Set(items.map((item) => item.tone))];
  const current = items[active]!;
  const running = auto && visible;

  return (
    <div
      ref={rootRef}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      className="grid gap-10 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-center lg:gap-14"
    >
      <ol className="border-t border-brand-line">
        {items.map((item, index) => {
          const isActive = index === active;
          return (
            <li key={item.id} className="relative border-b border-brand-line">
              <button
                type="button"
                aria-expanded={isActive}
                aria-controls={`tour-panel-${item.id}`}
                onClick={() => choose(index)}
                className="group flex w-full items-baseline gap-4 py-5 text-left"
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
                    {/*
                     * Every description is laid out in the same cell, only
                     * this item's visible, so each panel is as tall as the
                     * longest one and the page does not shift on advance.
                     * Only on large screens: on small ones the gap would sit
                     * above the screenshot.
                     */}
                    <div className="grid">
                      {items.map((other) =>
                        other === item ? (
                          <div key={other.id} className="[grid-area:1/1]">
                            <p className="text-[15px] leading-7 text-brand-muted">
                              {item.text}
                            </p>
                            {item.link ? (
                              <Link
                                href={item.link.href}
                                className="text-link mt-3 inline-flex text-sm"
                              >
                                {item.link.label}
                              </Link>
                            ) : null}
                          </div>
                        ) : (
                          <div
                            key={other.id}
                            aria-hidden
                            className="invisible hidden [grid-area:1/1] lg:block"
                          >
                            <p className="text-[15px] leading-7">{other.text}</p>
                            {other.link ? (
                              <span className="mt-3 inline-flex text-sm">
                                {other.link.label}
                              </span>
                            ) : null}
                          </div>
                        ),
                      )}
                    </div>
                    <div
                      className={`stage stage-${item.tone} mt-6 overflow-hidden rounded-[14px] p-4 lg:hidden`}
                    >
                      <AppShot
                        screen={item.screen}
                        alt={item.alt}
                        className="block h-auto w-full rounded-[8px] bg-brand-raised shadow-(--shadow-frame)"
                      />
                    </div>
                  </div>
                </div>
              </div>
              {isActive && running ? (
                <span
                  aria-hidden
                  key={`${item.id}-${active}`}
                  onAnimationEnd={advance}
                  className="tour-progress absolute inset-x-0 -bottom-px block h-px bg-brand-ink"
                  style={{
                    animationDuration: `${ADVANCE_MS}ms`,
                    animationPlayState: paused ? "paused" : "running",
                  }}
                />
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="relative hidden overflow-hidden rounded-[18px] lg:block">
        {tones.map((tone) => (
          <div
            key={tone}
            aria-hidden
            className={`stage stage-${tone} tour-layer ${
              tone === current.tone ? "is-active" : ""
            }`}
          />
        ))}
        <div className="relative z-10 grid px-10 py-12">
          {items.map((item, index) => (
            <figure
              key={item.id}
              aria-hidden={index !== active}
              className={`tour-shot overflow-hidden rounded-[12px] bg-brand-raised shadow-(--shadow-frame) [grid-area:1/1] ${
                index === active ? "is-active" : ""
              }`}
            >
              <AppShot screen={item.screen} alt={item.alt} className="block h-auto w-full" />
            </figure>
          ))}
        </div>
      </div>
    </div>
  );
}
