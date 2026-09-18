use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample, StreamConfig};
use tauri::{AppHandle, Emitter};

pub const SAMPLE_RATE: u32 = 16_000;

const MAX_DURATION: Duration = Duration::from_secs(5 * 60);

const LEVEL_INTERVAL: Duration = Duration::from_millis(66);

pub struct Recorder {
    stop: Sender<()>,
    thread: JoinHandle<Vec<f32>>,
}

impl Recorder {
    pub fn start(app: AppHandle) -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or("No microphone was found.")?;
        let supported = device
            .default_input_config()
            .map_err(|e| format!("Couldn't open the microphone: {e}"))?;
        let sample_format = supported.sample_format();
        let config: StreamConfig = supported.config();
        let channels = config.channels.max(1) as usize;
        let rate = config.sample_rate;

        let samples: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));

        let peak = Arc::new(AtomicU32::new(0));

        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        let thread_samples = samples.clone();
        let thread_peak = peak.clone();
        let thread = thread::spawn(move || {
            let stream = build_stream(
                &device,
                config,
                sample_format,
                channels,
                thread_samples,
                thread_peak.clone(),
            );
            let stream = match stream {
                Ok(stream) => stream,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return Vec::new();
                }
            };
            if let Err(e) = stream.play() {
                let _ = ready_tx.send(Err(format!("Couldn't start the microphone: {e}")));
                return Vec::new();
            }
            let _ = ready_tx.send(Ok(()));

            let started = Instant::now();
            let mut warned = false;
            loop {
                match stop_rx.recv_timeout(LEVEL_INTERVAL) {
                    Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
                    Err(RecvTimeoutError::Timeout) => {
                        let level = f32::from_bits(thread_peak.swap(0, Ordering::Relaxed));
                        let _ = app.emit("dictation:level", level);
                        if !warned && started.elapsed() >= MAX_DURATION {
                            warned = true;
                            let _ = app.emit("dictation:limit", ());
                        }
                    }
                }
            }

            drop(stream);
            let captured = std::mem::take(&mut *samples.lock().unwrap());
            resample(&captured, rate)
        });

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Recorder {
                stop: stop_tx,
                thread,
            }),
            Ok(Err(e)) => Err(e),

            Err(_) => Err("The microphone stopped unexpectedly.".into()),
        }
    }

    pub fn finish(self) -> Vec<f32> {
        let _ = self.stop.send(());
        self.thread.join().unwrap_or_default()
    }
}

fn build_stream(
    device: &cpal::Device,
    config: StreamConfig,
    format: cpal::SampleFormat,
    channels: usize,
    samples: Arc<Mutex<Vec<f32>>>,
    peak: Arc<AtomicU32>,
) -> Result<cpal::Stream, String> {
    use cpal::SampleFormat as F;
    match format {
        F::F32 => capture::<f32>(device, config, channels, samples, peak),
        F::I16 => capture::<i16>(device, config, channels, samples, peak),
        F::U16 => capture::<u16>(device, config, channels, samples, peak),
        F::I32 => capture::<i32>(device, config, channels, samples, peak),
        F::I8 => capture::<i8>(device, config, channels, samples, peak),
        F::U8 => capture::<u8>(device, config, channels, samples, peak),
        other => Err(format!(
            "The microphone uses an audio format Set can't read ({other:?})."
        )),
    }
}

fn capture<T>(
    device: &cpal::Device,
    config: StreamConfig,
    channels: usize,
    samples: Arc<Mutex<Vec<f32>>>,
    peak: Arc<AtomicU32>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    device
        .build_input_stream::<T, _, _>(
            config,
            move |data: &[T], _| {
                let mut loudest = 0f32;
                let mut buffer = samples.lock().unwrap();
                buffer.reserve(data.len() / channels);
                for frame in data.chunks(channels) {
                    let mut sum = 0f32;
                    for sample in frame {
                        sum += f32::from_sample(*sample);
                    }
                    let mono = sum / frame.len() as f32;
                    loudest = loudest.max(mono.abs());
                    buffer.push(mono);
                }
                drop(buffer);

                peak.fetch_max(loudest.to_bits(), Ordering::Relaxed);
            },
            |_| {},
            None,
        )
        .map_err(|e| format!("Couldn't open the microphone: {e}"))
}

fn resample(input: &[f32], from: u32) -> Vec<f32> {
    if from == SAMPLE_RATE || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from as f64 / SAMPLE_RATE as f64;
    let out_len = (input.len() as f64 / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let start = (i as f64 * ratio) as usize;
        let end = (((i + 1) as f64 * ratio) as usize).clamp(start + 1, input.len());
        let window = &input[start..end];
        out.push(window.iter().sum::<f32>() / window.len() as f32);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_already_at_rate_is_left_alone() {
        let input = vec![0.1, -0.2, 0.3];
        assert_eq!(resample(&input, SAMPLE_RATE), input);
    }

    #[test]
    fn downsampling_averages_rather_than_drops() {
        let input: Vec<f32> = (0..30)
            .map(|i| if i % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        let out = resample(&input, 48_000);
        assert_eq!(out.len(), 10);
        for value in out {
            assert!(value.abs() < 0.5, "aliased through: {value}");
        }
    }

    #[test]
    fn downsampling_preserves_a_steady_signal() {
        let input = vec![0.5f32; 44_100];
        let out = resample(&input, 44_100);
        assert_eq!(out.len(), 16_000);
        assert!(out.iter().all(|v| (v - 0.5).abs() < 1e-6));
    }

    #[test]
    fn upsampling_from_a_low_rate_still_produces_audio() {
        let input: Vec<f32> = (0..800).map(|i| i as f32 / 800.0).collect();
        let out = resample(&input, 8_000);
        assert_eq!(out.len(), 1_600);
        assert!(out.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn silence_stays_silent() {
        let out = resample(&vec![0.0f32; 4_800], 48_000);
        assert_eq!(out.len(), 1_600);
        assert!(out.iter().all(|v| *v == 0.0));
    }
}
