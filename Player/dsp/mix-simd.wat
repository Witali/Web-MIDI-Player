;; Included by tools/build-dsp.mjs in the SIMD variant. The biquad and envelope
;; ramp remain scalar because each sample depends on the preceding state.
;; Mix two Float32 samples as Float64 lanes, then round each sum to Float32,
;; exactly as the scalar engine does. Padding at most one internal sample for
;; odd block lengths is safe: only n output samples reach effects or the client.
(func $mixSimd (param $n i32) (param $left f64) (param $right f64)
  (param $reverb f64) (param $chorus f64) (param $delay f64) (param $insert i32)
  (local $i i32) (local $p i32) (local $l i32) (local $r i32) (local $s v128)
  (local $gl v128) (local $gr v128) (local $gv v128) (local $gc v128) (local $gd v128)
  (local.set $gl (f64x2.splat (local.get $left)))
  (local.set $gr (f64x2.splat (local.get $right)))
  (local.set $gv (f64x2.splat (local.get $reverb)))
  (local.set $gc (f64x2.splat (local.get $chorus)))
  (local.set $gd (f64x2.splat (local.get $delay)))
  (local.set $l (select (i32.const 3072) (i32.const 512) (local.get $insert)))
  (local.set $r (select (i32.const 3584) (i32.const 1024) (local.get $insert)))
  (block $end (loop $samples
    (br_if $end (i32.ge_u (local.get $i) (i32.shl (local.get $n) (i32.const 2))))
    (local.set $s (f64x2.promote_low_f32x4 (v128.load64_zero (local.get $i))))
    (local.set $p (i32.add (local.get $l) (local.get $i)))
    (v128.store64_lane 0 (local.get $p) (f32x4.demote_f64x2_zero (f64x2.add
      (f64x2.promote_low_f32x4 (v128.load64_zero (local.get $p))) (f64x2.mul (local.get $s) (local.get $gl)))))
    (local.set $p (i32.add (local.get $r) (local.get $i)))
    (v128.store64_lane 0 (local.get $p) (f32x4.demote_f64x2_zero (f64x2.add
      (f64x2.promote_low_f32x4 (v128.load64_zero (local.get $p))) (f64x2.mul (local.get $s) (local.get $gr)))))
    (if (i32.eqz (local.get $insert)) (then
      (if (f64.gt (local.get $reverb) (f64.const 0)) (then
        (local.set $p (i32.add (i32.const 1536) (local.get $i)))
        (v128.store64_lane 0 (local.get $p) (f32x4.demote_f64x2_zero (f64x2.add
          (f64x2.promote_low_f32x4 (v128.load64_zero (local.get $p))) (f64x2.mul (local.get $s) (local.get $gv)))))))
      (if (f64.gt (local.get $chorus) (f64.const 0)) (then
        (local.set $p (i32.add (i32.const 2048) (local.get $i)))
        (v128.store64_lane 0 (local.get $p) (f32x4.demote_f64x2_zero (f64x2.add
          (f64x2.promote_low_f32x4 (v128.load64_zero (local.get $p))) (f64x2.mul (local.get $s) (local.get $gc)))))))
      (if (f64.gt (local.get $delay) (f64.const 0)) (then
        (local.set $p (i32.add (i32.const 2560) (local.get $i)))
        (v128.store64_lane 0 (local.get $p) (f32x4.demote_f64x2_zero (f64x2.add
          (f64x2.promote_low_f32x4 (v128.load64_zero (local.get $p))) (f64x2.mul (local.get $s) (local.get $gd)))))))))
    (local.set $i (i32.add (local.get $i) (i32.const 8))) (br $samples)))
)
