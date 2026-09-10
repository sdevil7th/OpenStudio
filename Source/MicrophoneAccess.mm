#include "MicrophoneAccess.h"
#include <vector>
#import <AVFoundation/AVFoundation.h>

namespace MicrophoneAccess
{
Status status()
{
    switch ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio])
    {
        case AVAuthorizationStatusNotDetermined: return Status::notDetermined;
        case AVAuthorizationStatusAuthorized: return Status::authorized;
        case AVAuthorizationStatusDenied: return Status::denied;
        case AVAuthorizationStatusRestricted: return Status::restricted;
    }
    return Status::restricted;
}

void request(std::function<void(bool)> completion)
{
    if (!juce::MessageManager::getInstance()->isThisTheMessageThread())
    {
        juce::MessageManager::callAsync([completion = std::move(completion)]() mutable
        { request(std::move(completion)); });
        return;
    }
    const auto current = status();
    if (current != Status::notDetermined)
    {
        completion(current == Status::authorized);
        return;
    }
    static std::vector<std::function<void(bool)>> pending;
    pending.push_back(std::move(completion));
    if (pending.size() != 1) return;
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted)
    {
        juce::MessageManager::callAsync([granted]
        {
            auto callbacks = std::move(pending);
            pending.clear();
            for (auto& callback : callbacks) callback(granted == YES);
        });
    }];
}
}
