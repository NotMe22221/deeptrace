import { Building2, Cable, Droplets, TrainFront, Wifi, Zap, type LucideIcon } from "lucide-react";
import type { SystemType } from "@/types/infrastructure";

export const SYSTEM_ICONS: Record<SystemType, LucideIcon> = {
  water: Droplets,
  power: Zap,
  telecom: Wifi,
  transport: TrainFront,
  underground: Cable,
  facility: Building2,
};
