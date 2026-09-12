/**
 * Hand-maintained mirror of the SQL schema.
 *
 * Note these are `type` aliases, not `interface`s, and that is load-bearing:
 * Supabase's GenericTable constrains `Row` to `Record<string, unknown>`, and a
 * TypeScript interface has no implicit index signature, so an interface silently
 * fails the constraint and every `.from(...).select()` resolves to `never`.
 *
 * Once you have the Supabase CLI linked you can replace this file with the
 * generated version (`npm run db:types`); it is written by hand here so the
 * repo typechecks before anyone has run a migration.
 */

export type UserRole = 'owner' | 'admin' | 'manager' | 'employee';
export type EmploymentStatus = 'active' | 'suspended' | 'terminated';
export type PunchKind = 'check_in' | 'check_out';
export type DayStatus =
  | 'present'
  | 'late'
  | 'half_day'
  | 'absent'
  | 'holiday'
  | 'weekend'
  | 'on_leave';

export type PunchOutcome =
  | 'accepted'
  | 'rejected_no_match'
  | 'rejected_liveness'
  | 'rejected_quality'
  | 'rejected_geofence'
  | 'rejected_duplicate'
  | 'rejected_not_enrolled';

export type Organization = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  created_at: string;
  updated_at: string;
}

export type OrgSettings = {
  org_id: string;
  workday_start: string;
  workday_end: string;
  late_grace_minutes: number;
  half_day_max_minutes: number;
  full_day_min_minutes: number;
  workdays: number[];
  match_threshold: number;
  min_quality_score: number;
  liveness_mode: 'off' | 'passive' | 'active';
  min_liveness_score: number;
  geofence_enabled: boolean;
  geofence_lat: number | null;
  geofence_lng: number | null;
  geofence_radius_m: number;
  min_punch_gap_seconds: number;
  max_templates_per_user: number;
  store_punch_photo: boolean;
  photo_retention_days: number;
  require_device_binding: boolean;
  updated_at: string;
}

export type Profile = {
  id: string;
  org_id: string;
  email: string;
  full_name: string;
  employee_code: string | null;
  department: string | null;
  job_title: string | null;
  role: UserRole;
  status: EmploymentStatus;
  avatar_path: string | null;
  bound_device_hash: string | null;
  joined_on: string;
  created_at: string;
  updated_at: string;
}

export type PunchEvent = {
  id: string;
  org_id: string;
  user_id: string;
  kind: PunchKind;
  outcome: PunchOutcome;
  occurred_at: string;
  local_day: string;
  similarity: number | null;
  liveness_score: number | null;
  quality_score: number | null;
  matched_template: string | null;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  distance_m: number | null;
  device_hash: string | null;
  user_agent: string | null;
  photo_path: string | null;
  note: string | null;
  created_at: string;
}

export type AttendanceDay = {
  id: string;
  org_id: string;
  user_id: string;
  local_day: string;
  first_in: string | null;
  last_out: string | null;
  worked_minutes: number;
  status: DayStatus;
  punches: number;
  manually_edited: boolean;
  edited_by: string | null;
  edit_reason: string | null;
  created_at: string;
  updated_at: string;
}

export type TodayBoardRow = {
  user_id: string;
  org_id: string;
  full_name: string;
  employee_code: string | null;
  department: string | null;
  avatar_path: string | null;
  local_day: string | null;
  first_in: string | null;
  last_out: string | null;
  worked_minutes: number | null;
  status: DayStatus;
  punches: number | null;
  currently_in: boolean | null;
  enrolled: boolean;
}

export type MonthlySummaryRow = {
  org_id: string;
  user_id: string;
  full_name: string;
  employee_code: string | null;
  department: string | null;
  month: string;
  days_worked: number;
  days_present: number;
  days_late: number;
  days_half: number;
  days_absent: number;
  days_leave: number;
  total_minutes: number | null;
  avg_minutes: number | null;
}

export type AnomalyRow = {
  id: string;
  org_id: string;
  user_id: string;
  full_name: string;
  occurred_at: string;
  local_day: string;
  outcome: PunchOutcome;
  similarity: number | null;
  liveness_score: number | null;
  quality_score: number | null;
  distance_m: number | null;
  photo_path: string | null;
  device_hash: string | null;
}

export type FaceTemplateMeta = {
  id: string;
  org_id: string;
  user_id: string;
  quality: number;
  model_version: string;
  source: string;
  created_at: string;
  created_by: string | null;
  revoked_at: string | null;
}

export type AuditEntry = {
  id: number;
  org_id: string | null;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export type Holiday = {
  id: string;
  org_id: string;
  day: string;
  name: string;
  created_at: string;
}

/** What record_punch() returns. */
export type PunchResult = {
  ok: boolean;
  outcome: PunchOutcome;
  kind: PunchKind;
  event_id: string;
  similarity: number;
  threshold: number;
  distance_m: number | null;
  local_day: string;
  occurred_at: string;
}

export type EnrollResult = {
  template_id: string;
  templates: number;
}

type Row<T> = { Row: T; Insert: Partial<T>; Update: Partial<T>; Relationships: [] };

export type Database = {
  public: {
    Tables: {
      organizations: Row<Organization>;
      org_settings: Row<OrgSettings>;
      profiles: Row<Profile>;
      punch_events: Row<PunchEvent>;
      attendance_days: Row<AttendanceDay>;
      holidays: Row<Holiday>;
      audit_log: Row<AuditEntry>;
    };
    Views: {
      v_today_board: { Row: TodayBoardRow; Relationships: [] };
      v_monthly_summary: { Row: MonthlySummaryRow; Relationships: [] };
      v_anomalies: { Row: AnomalyRow; Relationships: [] };
      face_template_meta: { Row: FaceTemplateMeta; Relationships: [] };
    };
    Functions: {
      record_punch: {
        Args: {
          p_embedding: number[];
          p_liveness?: number | null;
          p_quality?: number | null;
          p_kind?: PunchKind | null;
          p_lat?: number | null;
          p_lng?: number | null;
          p_accuracy_m?: number | null;
          p_device_hash?: string | null;
          p_photo_path?: string | null;
          p_user_agent?: string | null;
        };
        Returns: PunchResult;
      };
      enroll_face: {
        Args: { p_embedding: number[]; p_quality: number; p_target?: string | null };
        Returns: EnrollResult;
      };
      identify_face: {
        Args: { p_embedding: number[] };
        Returns: {
          found: boolean;
          user_id?: string;
          full_name?: string;
          employee_code?: string | null;
          similarity?: number;
        };
      };
      revoke_face_templates: { Args: { p_user: string }; Returns: number };
      /** Service-role only — no grant exists for `authenticated`. */
      purge_expired_photos: { Args: Record<string, never>; Returns: number };
      admin_correct_day: {
        Args: {
          p_user: string;
          p_day: string;
          p_status: DayStatus;
          p_worked_minutes: number;
          p_reason: string;
        };
        Returns: undefined;
      };
    };
    Enums: {
      user_role: UserRole;
      employment_status: EmploymentStatus;
      punch_kind: PunchKind;
      punch_outcome: PunchOutcome;
      day_status: DayStatus;
    };
    CompositeTypes: Record<string, never>;
  };
}

/** User-facing copy for each rejection reason. */
export const OUTCOME_MESSAGE: Record<PunchOutcome, string> = {
  accepted: 'Attendance recorded',
  rejected_no_match: 'That does not look like your enrolled face. Try again in better light.',
  rejected_liveness: 'Liveness check failed. Please follow the on-screen prompts.',
  rejected_quality: 'The capture was too blurry or poorly lit to be reliable.',
  rejected_geofence: 'You are outside the allowed check-in area.',
  rejected_duplicate: 'You already punched a moment ago, or this is not your registered device.',
  rejected_not_enrolled: 'You have not enrolled your face yet.',
};

export const STATUS_LABEL: Record<DayStatus, string> = {
  present: 'Present',
  late: 'Late',
  half_day: 'Half day',
  absent: 'Absent',
  holiday: 'Holiday',
  weekend: 'Weekend',
  on_leave: 'On leave',
};
