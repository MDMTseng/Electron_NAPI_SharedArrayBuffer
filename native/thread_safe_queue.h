#ifndef THREAD_SAFE_QUEUE_H
#define THREAD_SAFE_QUEUE_H

#include <queue>
#include <mutex>
#include <condition_variable>
#include <vector>

template<typename T>
class ThreadSafeQueue {
public:
    ThreadSafeQueue() : interrupted_(false) {}

    void push(const T& item) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (!interrupted_) {
                queue_.push(item);
            }
        }
        condition_.notify_one();
    }

    void push(T&& item) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (!interrupted_) {
                queue_.push(std::move(item));
            }
        }
        condition_.notify_one();
    }

    bool pop(T& item) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (queue_.empty() || interrupted_) {
            return false;
        }
        item = std::move(queue_.front());
        queue_.pop();
        return true;
    }

    bool wait_and_pop(T& item, bool& should_continue) {
        std::unique_lock<std::mutex> lock(mutex_);
        condition_.wait(lock, [this, &should_continue]() {
            return !queue_.empty() || !should_continue || interrupted_;
        });

        if (!should_continue || interrupted_) {
            return false;
        }

        if (!queue_.empty()) {
            item = std::move(queue_.front());
            queue_.pop();
            return true;
        }
        return false;
    }

    bool empty() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return queue_.empty();
    }

    size_t size() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return queue_.size();
    }

    void clear() {
        std::lock_guard<std::mutex> lock(mutex_);
        std::queue<T> empty;
        std::swap(queue_, empty);
    }

    // New interrupt functions
    void interrupt() {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            interrupted_ = true;
        }
        condition_.notify_all(); // Wake up all waiting threads
    }

    void reset_interrupt() {
        std::lock_guard<std::mutex> lock(mutex_);
        interrupted_ = false;
    }

    bool is_interrupted() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return interrupted_;
    }

private:
    mutable std::mutex mutex_;
    std::condition_variable condition_;
    std::queue<T> queue_;
    bool interrupted_;
};

#endif // THREAD_SAFE_QUEUE_H 