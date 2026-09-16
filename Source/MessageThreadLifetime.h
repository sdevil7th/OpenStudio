#pragma once
#include <atomic>
#include <memory>

// A cancellation token for deferred MESSAGE-THREAD callbacks. Owner teardown
// and callback execution must share that thread; this is not a worker join or
// a lock that makes arbitrary concurrent dereferences of `this` safe.
class MessageThreadLifetime
{
public:
    using Token = std::shared_ptr<const std::atomic<bool>>;
    Token token() const noexcept { return alive; }
    void invalidate() noexcept { alive->store(false, std::memory_order_release); }
    ~MessageThreadLifetime() { invalidate(); }
    static bool accepts(const Token& token) noexcept { return token && token->load(std::memory_order_acquire); }
private:
    std::shared_ptr<std::atomic<bool>> alive = std::make_shared<std::atomic<bool>>(true);
};
