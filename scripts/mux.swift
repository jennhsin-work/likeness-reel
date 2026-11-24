// Attach an audio mix to the rendered picture using AVFoundation (ships with macOS,
// so no ffmpeg install is needed). Re-encodes to H.264 + AAC, web-optimised.
// usage: swift mux.swift <video.mp4> <audio.wav> <out.mp4>
import AVFoundation
import Foundation

let args = CommandLine.arguments
guard args.count == 4 else { FileHandle.standardError.write("usage: mux.swift <video> <audio> <out>\n".data(using: .utf8)!); exit(2) }
let video = AVURLAsset(url: URL(fileURLWithPath: args[1]))
let audio = AVURLAsset(url: URL(fileURLWithPath: args[2]))
let outURL = URL(fileURLWithPath: args[3])
try? FileManager.default.removeItem(at: outURL)

func fail(_ msg: String) -> Never { FileHandle.standardError.write((msg + "\n").data(using: .utf8)!); exit(1) }

let comp = AVMutableComposition()
guard let vSrc = video.tracks(withMediaType: .video).first else { fail("no video track") }
guard let aSrc = audio.tracks(withMediaType: .audio).first else { fail("no audio track") }
let range = CMTimeRange(start: .zero, duration: video.duration)
guard let vDst = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
      let aDst = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { fail("could not create tracks") }
do {
    try vDst.insertTimeRange(range, of: vSrc, at: .zero)
    let aRange = CMTimeRange(start: .zero, duration: CMTimeMinimum(audio.duration, video.duration))
    try aDst.insertTimeRange(aRange, of: aSrc, at: .zero)
} catch { fail("compose: \(error.localizedDescription)") }
vDst.preferredTransform = vSrc.preferredTransform

guard let export = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetHighestQuality) else { fail("no export session") }
export.outputURL = outURL
export.outputFileType = .mp4
export.shouldOptimizeForNetworkUse = true
let done = DispatchSemaphore(value: 0)
export.exportAsynchronously { done.signal() }
done.wait()
if export.status != .completed { fail("export: \(export.error?.localizedDescription ?? "status \(export.status.rawValue)")") }
print(outURL.path)
