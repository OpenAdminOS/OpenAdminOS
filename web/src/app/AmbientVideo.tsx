"use client";

import { useEffect, useState } from "react";

type AmbientVideoProps = {
  src: string;
  poster: string;
  className?: string;
  alt: string;
};

export function AmbientVideo({ src, poster, className, alt }: AmbientVideoProps) {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReducedMotion(mediaQuery.matches);

    updatePreference();
    mediaQuery.addEventListener("change", updatePreference);

    return () => {
      mediaQuery.removeEventListener("change", updatePreference);
    };
  }, []);

  if (reducedMotion) return <img src={poster} alt={alt} className={className} />;

  return (
    <video
      autoPlay
      muted
      loop
      playsInline
      preload="metadata"
      poster={poster}
      aria-label={alt}
      className={className}
    >
      <source src={src} type="video/mp4" />
    </video>
  );
}
